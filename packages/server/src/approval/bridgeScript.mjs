// The per-turn MCP server exposing Claude Code's --permission-prompt-tool. The `claude` CLI
// itself spawns THIS script (as a child of the `claude` process) per the --mcp-config entry
// claude-code.ts builds for "manual" mode turns - we never spawn it directly.
//
// Deliberately plain JS (not compiled from TS): it needs to run identically whether the main
// server is running via `tsx watch` (dev) or the compiled `dist/` build (prod), and it has no
// dependency on anything else in this package beyond @modelcontextprotocol/sdk.
//
// Schema verified empirically (2026-09-15) against a real `claude -p --permission-mode manual`
// invocation, since Anthropic's own docs don't publish it (see anthropics/claude-code#1175):
//   request:  {method:"tools/call", params:{name:"permission", arguments:
//              {tool_name: string, input: object, tool_use_id: string}}}
//   response (allow): {content:[{type:"text", text: JSON.stringify(
//              {behavior:"allow", updatedInput: <same input object>})}]}
// The "deny" shape below ({behavior:"deny", message}) is the standard canUseTool convention,
// not independently re-verified against a real deny - if Claude Code ever rejects it, that's
// the first thing to check.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const agentId = process.env.SOLACE_AGENT_ID;
const port = process.env.SOLACE_SERVER_PORT ?? "4310";
// Proves to the server that this process belongs to a turn that is actually running right now.
// Without it the internal route could be driven by anything able to reach the port.
const turnToken = process.env.SOLACE_TURN_TOKEN;

const server = new Server({ name: "approval-bridge", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "permission", description: "Approve or deny a tool call", inputSchema: { type: "object" } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { tool_name, input } = request.params.arguments ?? {};
  const description = `${tool_name ?? "unknown tool"}(${JSON.stringify(input ?? {})})`;

  const res = await fetch(`http://localhost:${port}/internal/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, turnToken, description }),
  });
  const { approved } = await res.json();

  const text = approved
    ? JSON.stringify({ behavior: "allow", updatedInput: input ?? {} })
    : JSON.stringify({ behavior: "deny", message: "Denied by the user." });
  return { content: [{ type: "text", text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
