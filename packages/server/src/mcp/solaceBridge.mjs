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

const GET_SECRET_DESCRIPTION = [
  "Get ONE saved credential out of the user's vault, by the label they gave it, so you can sign",
  "into something during this turn. Use it when a task actually requires signing in - a password",
  "for a site, a token for an API, the passphrase for an SSH key.",
  "",
  "You must name the entry you want. There is no way to ask for everything, on purpose. If you",
  "do not know what is saved, guess the label from the task and the error will list the labels",
  "that do exist.",
  "",
  "The user is shown a message in this agent's hub saying which entry you read and when, every",
  "single time, before the value reaches you. That is deliberate and not something to work",
  "around: do not fetch a secret 'just in case', and do not fetch one to check whether it exists.",
  "",
  "NEVER write the value you get back into a message, a file, a commit, a log, or your final",
  "answer. Use it in the command that needs it and nowhere else. If a command would echo it,",
  "pass it in a way that does not (a prompt, an env var, a file you delete afterwards).",
].join("\n");

const RESERVE_PORT_DESCRIPTION = [
  "Get a port that is genuinely free and is then held in YOUR name, before you start anything on",
  "it. Call this instead of picking a number - two agents in this chat have already restarted each",
  "other's servers by both deciding on the same port in conversation.",
  "",
  "The port you get back has just been bind-tested, so it is not merely unclaimed inside Solace -",
  "nothing on this machine is on it. Another agent asking after you gets a different port and is",
  "told you hold this one.",
  "",
  "Release it with release_port when you are done.",
].join("\n");

const START_SERVER_DESCRIPTION = [
  "Start a long-running server (a dev server, a preview, an API) in a way that SURVIVES the end of",
  "your turn.",
  "",
  "This matters more than it sounds. A server you start with your own shell tool is a child of the",
  "process running your turn, and that whole process tree is killed when the turn ends or is",
  "stopped. So the URL is live while you are writing about it and dead by the time the user clicks",
  "it - which has happened repeatedly and is why this tool exists. A server started HERE is",
  "launched by the Solace server itself, detached from your turn, and keeps running until",
  "somebody stops it from the Running servers panel.",
  "",
  "Pass a port you got from reserve_port. The command must be one line and runs in your working",
  "directory. Do not use this for a command that finishes on its own (a build, a test run) - use",
  "your normal shell tool for those.",
  "",
  "IMPORTANT: a server started any other way still dies with your turn. If you want it to be there",
  "afterwards, it has to be started with this.",
].join("\n");

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
    {
      name: "claim_files",
      description:
        "Take ownership of the files or folders you are about to write, BEFORE you start. Other agents are " +
        "told what you own and are instructed not to touch it. Claiming a folder covers files inside it that " +
        "do not exist yet. If someone already owns something you asked for, you are told who - talk to them " +
        "rather than editing it anyway.",
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Paths or folders, relative to your working directory.",
          },
          note: { type: "string", description: "Optional: what you are doing with them." },
        },
        required: ["paths"],
      },
    },
    {
      name: "release_files",
      description:
        "Give up files you claimed, so somebody else can take that lane. Call this when you finish with them. " +
        "Omit `paths` to release everything you hold.",
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" } } },
      },
    },
    {
      name: "post_contract",
      description:
        "Publish a decision the others must build against - an API signature, a set of CSS tokens, a file " +
        "layout. It is pinned into every agent's context from now on, so nobody has to ask you for it again " +
        "and nobody builds against a stale version. Posting the same title again REPLACES it. Anyone who said " +
        "they were waiting for this is woken automatically.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short and stable, e.g. \"checker API\" or \"design tokens\"." },
          body: { type: "string", description: "The actual contract: names, signatures, values. Be specific." },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "announce",
      description:
        "Tell everyone something that needs no answer - progress, a file landing, a heads-up. This costs NOBODY " +
        "a turn: it is shown to the user now and folded into each other agent's context next time they run. " +
        "Use post_to_group instead when you actually need someone to act or reply.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "block_on",
      description:
        "Say what you are waiting for, then end your turn. You will be given a new turn automatically the " +
        "moment it lands - so do NOT idle, poll, or end without saying this, which is how work silently stalls. " +
        "kind=contract waits for a contract whose title matches, kind=file for a path to exist, kind=agent for " +
        "that agent to post.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["contract", "file", "agent"] },
          value: {
            type: "string",
            description: "The contract title, the file path, or the handle (with or without a leading @).",
          },
          why: { type: "string", description: "Optional: what you will do once it arrives." },
        },
        required: ["kind", "value"],
      },
    },
    {
      name: "list_tasks",
      description:
        "Show the shared task board for this chat: every task, who owns it, what it is waiting for and " +
        "which files it covers. Call this FIRST, before you decide what to work on - the board is what " +
        "stops two agents building the same thing, which has actually happened here twice.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_task",
      description:
        "Put a piece of work on the board so it has an owner, an id everyone can refer to, and a place in " +
        "the order. Use it for work you are about to start, and for work you are handing to someone else. " +
        "`depends_on` is what must be FINISHED first: a task that depends on another is not started, and " +
        "whoever owns it is woken automatically the moment the dependency is finished - so express an " +
        "ordering here rather than asking another agent to tell you when they are done.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "One line saying what is to be done. Specific enough to claim." },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: 'Task ids that must be finished first, e.g. ["T1","T2"]. Call list_tasks for the ids.',
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Files or folders this task covers, relative to your working directory. Claiming the task claims " +
              "these, so other agents are told not to touch them.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "claim_task",
      description:
        "Take a task, by id, BEFORE you start building it. This is the one call that actually prevents " +
        "duplicated work: a task can only be claimed once, so if someone already owns it you are told who " +
        "instead of quietly building a second copy. It also claims that task's files for you. " +
        "If the task waits on an unfinished one, you take ownership but must NOT start - end your turn, and " +
        "you will be given a fresh one automatically the moment the dependency is finished.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: 'The id from list_tasks, e.g. "T3".' } },
        required: ["task_id"],
      },
    },
    {
      name: "finish_task",
      description:
        "Mark your task done, and release its files. Everyone whose own task was waiting on this one is " +
        "given a turn immediately - so this is how work moves on, and skipping it leaves them idle waiting " +
        "for something that already happened. Only say it is done if it actually is.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          result: { type: "string", description: "Optional: one line on what landed, for the board." },
        },
        required: ["task_id"],
      },
    },
    {
      name: "reserve_port",
      description: RESERVE_PORT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          preferred: {
            type: "integer",
            description:
              "Optional: a specific port you would like. It is given to you only if nobody holds it AND nothing is actually listening on it; otherwise you get a different one and are told exactly why.",
          },
          purpose: {
            type: "string",
            description: 'What it is for, e.g. "the marketing site preview". Shown to the other agents.',
          },
        },
      },
    },
    {
      name: "start_server",
      description: START_SERVER_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command line that starts the server, on ONE line (chain with &&). It runs in your working directory.",
          },
          port: {
            type: "integer",
            description: "The port it will listen on. Call reserve_port first and pass what it gave you.",
          },
          purpose: { type: "string", description: "Optional: what this server is, for the Running servers panel." },
        },
        required: ["command", "port"],
      },
    },
    {
      name: "list_servers",
      description:
        "What is actually running right now and who holds which port - checked against real process ids, not " +
        "remembered. Look here before you assume a port is free, before you restart anything, and before you tell " +
        "the group a URL is live.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "release_port",
      description:
        "Give a port back when you are finished with it, so another agent can have it. Only you can release the " +
        "ports you hold. This does NOT stop a server - use it after the server is gone.",
      inputSchema: {
        type: "object",
        properties: { port: { type: "integer" } },
        required: ["port"],
      },
    },
    {
      name: "get_secret",
      description: GET_SECRET_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              'The label of the ONE saved entry you need, exactly as the user named it (e.g. "prod-web" or "grafana login"). Required - there is no all-secrets form.',
          },
        },
        required: ["label"],
      },
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

    if (name === "claim_files") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string" && p.trim()) : [];
      if (paths.length === 0) return toolError("claim_files needs a non-empty `paths` array.");
      const { status, json } = await callServer("/internal/solace/claim", { paths, note: args.note });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The claim was refused.");
      const taken = json.claimed?.length ? `You now own: ${json.claimed.join(", ")}.` : "Nothing new was claimed.";
      // A conflict is reported rather than hidden: the agent needs to know WHO to talk to, and
      // silently dropping the path is how two agents both end up believing they own a file.
      const clash = json.conflicts?.length
        ? ` Already owned by someone else: ${json.conflicts.map((c) => `${c.path} (@${c.owner})`).join(", ")}.` +
          ` @mention them if you need a change there - do not edit it yourself.`
        : "";
      return withInbound(taken + clash, json);
    }

    if (name === "release_files") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string" && p.trim()) : undefined;
      const { status, json } = await callServer("/internal/solace/release", { paths });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The release was refused.");
      return withInbound(`Released ${json.released ?? 0} path(s).`, json);
    }

    if (name === "post_contract") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!title || !body) return toolError("post_contract needs both `title` and `body`.");
      const { status, json } = await callServer("/internal/solace/contract", { title, body });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The contract was refused.");
      const woke = json.woken?.length ? ` Woke ${json.woken.length} agent(s) who were waiting for it.` : "";
      return withInbound(
        `Contract "${title}" published. Every agent now sees it in their context, so you do not need to repeat it.` +
          woke,
        json,
      );
    }

    if (name === "announce") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return toolError("announce needs a non-empty `text`.");
      const { status, json } = await callServer("/internal/solace/announce", { text });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The announcement was refused.");
      return withInbound("Announced. Nobody was given a turn for it; they will see it on their next one.", json);
    }

    if (name === "block_on") {
      const kind = typeof args.kind === "string" ? args.kind : "";
      const value = typeof args.value === "string" ? args.value.trim() : "";
      if (!["contract", "file", "agent"].includes(kind)) {
        return toolError('block_on needs `kind` to be "contract", "file" or "agent".');
      }
      if (!value) return toolError("block_on needs `value` - what exactly you are waiting for.");
      const { status, json } = await callServer("/internal/solace/block", { kind, value, why: args.why });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The block was refused.");
      return withInbound(
        json.wokenImmediately
          ? "That had already happened, so you have been given a fresh turn instead of waiting."
          : "Recorded. End your turn now - you will be given a new one automatically when it lands.",
        json,
      );
    }

    if (name === "list_tasks") {
      const { status, json } = await callServer("/internal/solace/task/list", {});
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      const tasks = Array.isArray(json?.tasks) ? json.tasks : [];
      if (tasks.length === 0) {
        return withInbound(
          "The board is empty. Create the work you are about to do with create_task, so the others can see it is taken.",
          json,
        );
      }
      // Rendered as lines rather than raw JSON: this is read by a model, and the fields that
      // decide what it does next (who owns it, what it waits for) should not be buried in
      // punctuation. Finished tasks stay listed - "already done" is the answer to the question
      // that was actually asked in a real chat, after the answer had already been posted.
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const lines = tasks.map((t) => {
        const waiting = (t.dependsOn ?? []).filter((d) => byId.get(d) && byId.get(d).status !== "done");
        const state =
          t.status === "done"
            ? `done by @${t.ownerHandle ?? "?"}${t.result ? ` - ${t.result}` : ""}`
            : t.status === "claimed"
              ? `@${t.ownerHandle}${waiting.length ? ` (waiting on ${waiting.join(", ")})` : " (in progress)"}`
              : "unclaimed";
        const files = t.files?.length ? ` [files: ${t.files.join(", ")}]` : "";
        const deps = t.dependsOn?.length ? ` [after: ${t.dependsOn.join(", ")}]` : "";
        return `${t.id} ${state}: ${t.title}${deps}${files}`;
      });
      return withInbound(lines.join("\n"), json);
    }

    if (name === "create_task") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return toolError("create_task needs a `title` - one line saying what is to be done.");
      const { status, json } = await callServer("/internal/solace/task/create", {
        title,
        depends_on: Array.isArray(args.depends_on) ? args.depends_on : undefined,
        files: Array.isArray(args.files) ? args.files : undefined,
      });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The task was refused.");
      // An unknown dependency id is surfaced, not swallowed: it means the task looks ready to
      // start when the author believed it was not.
      const unknown = json.unknownDeps?.length
        ? ` WARNING: no task called ${json.unknownDeps.join(", ")} exists in this chat, so nothing is actually ` +
          `holding this back. Call list_tasks and create_task again with the right ids if that is wrong.`
        : "";
      return withInbound(
        `${json.task.id} is on the board: ${json.task.title}. Everyone sees it in their context. ` +
          `Call claim_task("${json.task.id}") if you are the one doing it.${unknown}`,
        json,
      );
    }

    if (name === "claim_task") {
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      if (!taskId) return toolError('claim_task needs a `task_id`, e.g. "T3". Call list_tasks for the ids.');
      const { status, json } = await callServer("/internal/solace/task/claim", { task_id: taskId });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The claim was refused.");
      const clash = json.files?.conflicts?.length
        ? ` Some of its files are owned by someone else: ${json.files.conflicts
            .map((c) => `${c.path} (@${c.owner})`)
            .join(", ")}. @mention them rather than editing those.`
        : "";
      if (json.blocked) {
        return withInbound(
          `You own ${json.task.id} (${json.task.title}), but do NOT start it: it waits on ` +
            `${json.waitingOn.map((t) => t.id).join(", ")}. End your turn now - you will be given a fresh one ` +
            `automatically the moment ${json.waitFor.id} is finished. Do not poll and do not build it anyway.${clash}`,
          json,
        );
      }
      const files = json.files?.claimed?.length ? ` You now own: ${json.files.claimed.join(", ")}.` : "";
      return withInbound(
        `${json.task.id} is yours: ${json.task.title}. Nobody else can claim it now.${files}${clash} ` +
          `Call finish_task when it is actually done.`,
        json,
      );
    }

    if (name === "finish_task") {
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      if (!taskId) return toolError("finish_task needs a `task_id`.");
      const { status, json } = await callServer("/internal/solace/task/finish", {
        task_id: taskId,
        result: typeof args.result === "string" ? args.result : undefined,
      });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The task could not be finished.");
      const woke = json.unblocked?.length
        ? ` That unblocked ${json.unblocked.map((t) => `${t.id} (@${t.ownerHandle})`).join(", ")} - they have ` +
          `been given a turn already, so you do not need to @mention them about it.`
        : "";
      return withInbound(`${json.task.id} is done, and its files are released.${woke}`, json);
    }

    if (name === "reserve_port") {
      const { status, json } = await callServer("/internal/solace/reserve-port", {
        preferred: typeof args.preferred === "number" ? args.preferred : undefined,
        purpose: args.purpose,
      });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "No port could be reserved.");
      // The refusal reason is carried through verbatim and NOT softened: "@codex holds 4545" is
      // the whole value of asking, and an agent told only "here is 4401" asks for 4545 again
      // on its next turn.
      const refused = json.preferredRefused ? ` You did not get the port you asked for: ${json.preferredRefused}` : "";
      return withInbound(
        `Port ${json.port} is yours - it was bind-tested free just now and is held in your name.` +
          refused +
          ` Start your server with start_server on ${json.port} so it outlives this turn.`,
        json,
      );
    }

    if (name === "release_port") {
      const port = typeof args.port === "number" ? args.port : Number(args.port);
      if (!Number.isInteger(port)) return toolError("release_port needs the `port` number you were given.");
      const { status, json } = await callServer("/internal/solace/release-port", { port });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "That port could not be released.");
      return withInbound(
        json.released ? `Released port ${port}.` : `You were not holding port ${port}, so nothing changed.`,
        json,
      );
    }

    if (name === "start_server") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const port = typeof args.port === "number" ? args.port : Number(args.port);
      if (!command) return toolError("start_server needs a `command`.");
      if (!Number.isInteger(port)) return toolError("start_server needs a `port` - call reserve_port first.");
      const { status, json } = await callServer("/internal/solace/start-server", { command, port, purpose: args.purpose });
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      if (json?.ok !== true) return toolError(json?.error ?? "The server was not started.");
      return withInbound(
        `Started: ${json.server.command} (pid ${json.server.pid}) on port ${json.server.port}. It is detached from ` +
          `this turn and will still be running after your turn ends. Output is being written to ${json.server.logPath}. ` +
          `Before telling anyone it is live, check it - the URL you post will be badged with a real HTTP status.`,
        json,
      );
    }

    if (name === "list_servers") {
      const { status, json } = await callServer("/internal/solace/servers", {});
      if (status === 403) return toolError("This turn is no longer the agent's in-flight turn.");
      return withInbound(
        JSON.stringify({ servers: json?.servers ?? [], reservations: json?.reservations ?? [] }),
        json,
      );
    }

    if (name === "get_secret") {
      const label = typeof args.label === "string" ? args.label.trim() : "";
      if (!label) return toolError("get_secret needs the `label` of the one entry you want.");
      const { status, json } = await callServer("/internal/solace/secret", { label });
      if (status === 403) {
        // Covers both "your turn ended" and "you are in plan mode" - the server's own message
        // says which, and neither is something to retry blindly.
        return toolError(json?.error ?? "This turn may not read saved credentials.");
      }
      if (json?.ok !== true) return toolError(json?.error ?? "That entry could not be read.");
      // The value goes into this tool result, which reaches the model and nothing else. It is
      // deliberately NOT routed through post_to_group and never touches the chat log: the
      // user's visible record of this is the system message the server already posted into
      // this agent's hub, which names the entry and not the value.
      const fields = Array.isArray(json.fields) ? json.fields : [];
      const body = fields.map((f) => `${f.name}: ${f.value}`).join("\n");
      return withInbound(
        `Saved entry "${json.label}". The user has been shown that you read it.\n\n${body}\n\nUse this in the command that needs it. Do not repeat it in any message, file or final answer.`,
        json,
      );
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
