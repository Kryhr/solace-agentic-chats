// The per-turn MCP server that lets an agent talk to the group chat WHILE its turn is still
// running. The provider CLI (`claude`, and best-effort `codex`) spawns THIS script itself per
// the mcp config the adapters build - we never spawn it directly.
//
// Why it exists: until this, only an agent's FINAL message of a finished turn was mirrored
// into the group chat. Every intermediate message went to that agent's own hub only, so a
// real, observed mid-work message ("@claude I'm proposing a restrained apothecary palette...")
// never reached the other agent, and another agent announced "now I'll message the group with
// the direction I'm taking" when it had no mechanism to do that at all. Agents could only
// discover each other's work after the fact, which is the opposite of collaborating.
//
// Deliberately plain JS (not compiled from TS), for the same reason as
// approval/bridgeScript.mjs: it must run identically whether the main server is running via
// `tsx watch` (dev) or the compiled `dist/` build (prod), and it depends on nothing in this
// package beyond @modelcontextprotocol/sdk.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const agentId = process.env.SOLACE_AGENT_ID;
const port = process.env.SOLACE_SERVER_PORT ?? "4310";
// Proves to the server that this process belongs to a turn that is actually running right now.
// Without it the internal route could be driven by anything able to reach the port, and a
// child that outlived its turn could keep posting as the agent.
const turnToken = process.env.SOLACE_TURN_TOKEN;

const POST_DESCRIPTION = [
  "Post a message into the shared group chat RIGHT NOW, in the middle of your turn, without",
  "waiting for your current turn to finish. This is the only way to talk to your teammates",
  "while you are still working: the text of your normal final answer is not delivered to",
  "anyone until your whole turn ends, which is often many minutes later and far too late to",
  "actually coordinate on anything.",
  "",
  "Use it to say what direction you are taking BEFORE you commit to it, to claim or hand off a",
  "piece of work so two agents don't independently build the same thing, to report a decision",
  "that affects someone else's work, or to ask another agent a question and get their answer",
  "back while you are still working.",
  "",
  'To reach a specific agent you MUST write their handle with a literal "@" in the text (e.g.',
  '"@codex should the palette stay muted?"). Writing their name without the "@" is just text',
  "and reaches nobody. Call list_agents first if you are not sure who is here.",
  "",
  "IMPORTANT: do not then repeat that same @mention in your final answer for this turn. The",
  "other agent has already been given the message and repeating it bills them for a second",
  "turn answering a question you already asked here.",
].join("\n");

const KIND_DESCRIPTION = [
  'How the message should be treated. "question" means you need an answer back, so whoever you',
  'addressed is expected to reply. "work" (a status update on what you are building) and "fyi"',
  "(information nobody needs to act on) do not ask for a reply, and will not automatically",
  "bounce a turn back to whoever addressed you - though an explicit @mention still always",
  'reaches that agent. Defaults to "fyi".',
].join(" ");

const LIST_DESCRIPTION = [
  "List the other agents in this group chat right now: their handle (the name you @mention),",
  "their provider, what they are doing at this moment (idle / thinking / waiting-approval) and",
  "the task they are currently assigned. Check this before handing work off or asking a",
  "question - an agent that is already 'thinking' is mid-turn and will not see your message",
  "until its current turn ends.",
].join(" ");

const server = new Server({ name: "solace", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "post_to_group",
      description: POST_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              'What to say to the group. Include a literal "@handle" for anyone you want this to actually reach.',
          },
          kind: { type: "string", enum: ["question", "work", "fyi"], description: KIND_DESCRIPTION },
        },
        required: ["text"],
      },
    },
    {
      name: "list_agents",
      description: LIST_DESCRIPTION,
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

/** An MCP tool error the model can actually read and act on, rather than a dropped message. */
function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Every successful tool response carries back any messages that arrived for this agent while it
 * was working (the server's `inbound` field - see AgentManager.takeInboundNotice). This is the
 * cooperative half of interruption: the agent is already stopped here waiting on a tool result,
 * so this is a safe boundary at which to hand it something new, with nothing killed and no
 * context lost. The alternative - the server aborting the turn after a grace period - costs a
 * killed CLI, possibly a half-applied edit, and a billed resume, so it only exists as a fallback
 * for agents that never call a solace tool at all.
 *
 * The server has already taken these off the agent's queue by the time they appear here, so they
 * will not be delivered again and dropping them would lose them outright.
 */
function withInbound(text, json) {
  const inbound = typeof json?.inbound === "string" ? json.inbound.trim() : "";
  return { content: [{ type: "text", text: inbound ? `${text}\n\n${inbound}` : text }] };
}

async function callServer(path, body) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, turnToken, ...body }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    if (name === "post_to_group") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return toolError("post_to_group needs a non-empty `text`.");
      const { status, json } = await callServer("/internal/solace/post", { text, kind: args.kind });
      if (status === 403) {
        return toolError(
          "This turn is no longer the agent's in-flight turn, so the message was not posted. " +
            "It was probably stopped or timed out - do not retry.",
        );
      }
      if (json?.ok !== true) return toolError(json?.error ?? "The group chat rejected this message.");
      return withInbound("Posted to the group chat.", json);
    }

    if (name === "list_agents") {
      const { status, json } = await callServer("/internal/solace/agents", {});
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      return withInbound(JSON.stringify(json?.agents ?? []), json);
    }

    return toolError(`Unknown tool "${name}".`);
  } catch (err) {
    // The main server being unreachable must not take the agent's whole turn down with it -
    // report it as a tool failure the model can work around, not an uncaught throw.
    return toolError(`Could not reach the Solace server: ${err instanceof Error ? err.message : String(err)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
