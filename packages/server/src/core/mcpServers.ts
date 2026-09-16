import { nanoid } from "nanoid";
import { killCliTree, spawnCli } from "./spawnCli";
import { revealCredential } from "./credentials";
import {
  MCP_SERVER_NAME_PATTERN,
  RESERVED_MCP_SERVER_NAMES,
  type McpEnvEntry,
  type McpServerConfig,
  type McpServerScope,
} from "@solace/shared";

/**
 * The store, validation, secret resolution and live verification for user-registered MCP
 * servers. The per-adapter *injection* lives in each adapter, because each CLI takes MCP
 * config differently (replace / additional / -c override / temp settings file) - see
 * docs/MCP-SERVERS-PLAN.md. What every adapter shares is exactly one thing: the list of
 * servers that apply to the agent taking this turn, which is what `mcpServersForAgent()`
 * below hands them.
 *
 * SCOPE: CLI-backed agents only. An endpoint or local-model agent does not run a CLI - it runs
 * this app's own tool-calling loop in core/agentTools.ts, which has a fixed set of tools and no
 * MCP client at all. Giving those agents MCP means writing an MCP client in the server (spawn,
 * initialise, tools/list, surface the schemas into the loop, route tools/call) and, harder,
 * deciding how gateFor() trust gating applies to a tool whose blast radius we cannot inspect:
 * our path-containment guarantees mean nothing for a server that talks to a network API. That
 * is deliberate follow-on work, not an oversight - see docs/MCP-SERVERS-PLAN.md #5. Until it
 * lands, McpPanel says so plainly rather than letting a user wonder why a registered server
 * never appears for their Ollama agent.
 */

/** What an adapter actually needs to write into its own config shape. Deliberately a flat,
 * already-resolved value: no credential ids, no scope, no enabled flag - by the time this
 * exists every one of those decisions has been made. */
export interface ResolvedMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface McpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: McpEnvEntry[];
  enabled?: boolean;
  scope?: McpServerScope;
  note?: string;
}

/**
 * Fail-closed at the write boundary, for the same reason validateAgentConfig.ts exists: a
 * malformed entry here does not surface as a validation message, it surfaces as a CLI turn
 * that dies on startup with a config parse error and no obvious cause.
 *
 * `existing` is every other server, so a duplicate name is caught here rather than becoming a
 * silent last-one-wins collision inside whichever adapter merges the JSON.
 */
export function validateMcpServer(
  input: McpServerInput,
  existing: McpServerConfig[],
): { error: string } | { value: Omit<McpServerConfig, "id" | "createdAt"> } {
  const name = (input.name ?? "").trim().toLowerCase();
  if (!name) return { error: "A server name is required." };
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return {
      error:
        "A server name must be lowercase letters, digits, hyphens or underscores, starting with a letter or digit. " +
        "Agents address a tool as mcp__<server>__<tool> (Claude, Qwen) or <server>-<tool> (Copilot), so anything else is ambiguous.",
    };
  }
  if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(name)) {
    return {
      error: `"${name}" is reserved - Solace registers a server under that name on every turn. A second one would shadow it, and agents would silently stop being able to talk to each other.`,
    };
  }
  if (existing.some((s) => s.name === name)) return { error: `A server named "${name}" already exists.` };

  const command = (input.command ?? "").trim();
  if (!command) return { error: "A command is required." };

  const args = Array.isArray(input.args) ? input.args.filter((a) => typeof a === "string") : [];

  const envIn = Array.isArray(input.env) ? input.env : [];
  const env: McpEnvEntry[] = [];
  for (const raw of envIn) {
    const varName = (raw?.name ?? "").trim();
    if (!varName) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return { error: `"${varName}" is not a valid environment variable name.` };
    if (raw.credentialId) env.push({ name: varName, credentialId: String(raw.credentialId) });
    else env.push({ name: varName, value: String(raw.value ?? "") });
  }

  const scope: McpServerScope =
    input.scope?.kind === "agents"
      ? { kind: "agents", agentIds: Array.isArray(input.scope.agentIds) ? input.scope.agentIds.filter((a) => typeof a === "string") : [] }
      : { kind: "global" };

  return {
    value: {
      name,
      transport: "stdio",
      command,
      args,
      env,
      enabled: input.enabled !== false,
      scope,
      note: input.note?.trim() || undefined,
    },
  };
}

/** Restore from `.solace-state.json`. Hand-edited or older files are guarded on shape, not on
 * presence, for the same reason persistence.ts guards `coordination`: a null or an array of
 * strings must restore as "no servers", never throw on the first `.filter` at boot. */
export function sanitizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<McpServerConfig>;
    if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.command !== "string") continue;
    if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(s.name)) continue;
    out.push({
      id: s.id,
      name: s.name,
      transport: "stdio",
      command: s.command,
      args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [],
      env: Array.isArray(s.env) ? (s.env.filter((e) => e && typeof (e as McpEnvEntry).name === "string") as McpEnvEntry[]) : [],
      enabled: s.enabled !== false,
      scope: s.scope?.kind === "agents" ? { kind: "agents", agentIds: Array.isArray(s.scope.agentIds) ? s.scope.agentIds : [] } : { kind: "global" },
      createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date(0).toISOString(),
      note: typeof s.note === "string" ? s.note : undefined,
      lastVerified:
        s.lastVerified && typeof s.lastVerified.at === "string" && Array.isArray(s.lastVerified.tools)
          ? { at: s.lastVerified.at, tools: s.lastVerified.tools.filter((t): t is string => typeof t === "string") }
          : undefined,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The outward-facing shape, mirroring credentials.ts's `toMeta()` and for the same reason: a
 * secret must not be able to travel out through a GET by accident.
 *
 * A vault-referenced env value never leaves the server at all - the client sees the credential
 * id it already chose, never the resolved value. A literal value DOES go back out, because the
 * user typed it into this form and has to be able to edit it; the UI states plainly that a
 * literal is stored in plaintext and that a token belongs in the vault instead.
 *
 * Fail-closed on shape: an entry carrying BOTH a credentialId and a literal (only reachable by
 * hand-editing the state file) is returned as the credential reference, never as the literal.
 */
export function toPublicMcpServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    env: server.env.map((e) => (e.credentialId ? { name: e.name, credentialId: e.credentialId } : { name: e.name, value: e.value ?? "" })),
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/** Does this server apply to this agent? A global server applies to everyone; an agent-scoped
 * one applies only to the agents named, which is the whole point - see McpServerScope. */
export function appliesToAgent(server: McpServerConfig, agentId: string): boolean {
  if (!server.enabled) return false;
  return server.scope.kind === "global" || server.scope.agentIds.includes(agentId);
}

/**
 * Resolve every enabled server that applies to `agentId` into what an adapter can spawn.
 *
 * Vault-referenced env values are read here, at spawn time, and never persisted anywhere:
 * `revealCredential` is the one audited function that returns real values, and this is a
 * server-internal caller that passes the value straight into a child's environment. A
 * credential that has been deleted resolves to nothing, and the variable is OMITTED rather
 * than set to an empty string - an MCP server told its token is "" usually fails with a
 * clear auth error, where one told nothing at all fails with a clear missing-config error,
 * and neither silently behaves as if the user had authenticated.
 */
export function resolveMcpServers(servers: McpServerConfig[], agentId: string, workspaceRoot: string): ResolvedMcpServer[] {
  return servers
    .filter((s) => appliesToAgent(s, agentId))
    .map((s) => {
      const env: Record<string, string> = {};
      for (const entry of s.env) {
        if (entry.credentialId) {
          const revealed = revealCredential(workspaceRoot, entry.credentialId);
          const value = revealed?.fields[0]?.value;
          if (value) env[entry.name] = value;
        } else if (entry.value) {
          env[entry.name] = entry.value;
        }
      }
      return { name: s.name, command: s.command, args: s.args, env };
    });
}

/* -------------------------------------------------------------------------- */
/* The registry the adapters read                                              */
/* -------------------------------------------------------------------------- */

/**
 * Adapters reach the user's servers through this module-level hook rather than through a new
 * RunTurnOptions field.
 *
 * That is deliberate: every adapter already reaches for ambient per-turn facts the same way
 * (`process.env.PORT` for the bridge's callback port, `__dirname` for the bridge script), and
 * routing this through the turn plumbing instead would mean every caller of runTurn - the
 * queue, the retry path, the interrupt path - had to remember to pass it, with "the agent
 * silently lost its MCP servers on retries only" as the failure mode when one forgot.
 *
 * Unset means no user servers, which is exactly what a fresh install has and what every
 * existing adapter unit test sees - so nothing changes shape until a server is registered.
 */
let provider: ((agentId: string) => ResolvedMcpServer[]) | undefined;

export function setMcpServerProvider(fn: ((agentId: string) => ResolvedMcpServer[]) | undefined) {
  provider = fn;
}

/**
 * Every user server that applies to this agent. Never throws: a broken provider must not be
 * able to take down a turn that would otherwise have run fine with the solace bridge alone.
 */
export function mcpServersForAgent(agentId: string): ResolvedMcpServer[] {
  if (!provider) return [];
  try {
    return provider(agentId) ?? [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

export class McpServerStore {
  private servers: McpServerConfig[];
  onChange?: () => void;

  constructor(initial: McpServerConfig[] = []) {
    this.servers = initial;
  }

  /** Raw records, including credential ids - server-internal callers only (resolution, the
   * persist snapshot). Anything answering an HTTP request wants `listPublic()`. */
  list(): McpServerConfig[] {
    return this.servers;
  }

  listPublic(): McpServerConfig[] {
    return this.servers.map(toPublicMcpServer);
  }

  get(id: string): McpServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  add(input: McpServerInput): { error: string } | { server: McpServerConfig } {
    const checked = validateMcpServer(input, this.servers);
    if ("error" in checked) return checked;
    const server: McpServerConfig = { ...checked.value, id: nanoid(10), createdAt: new Date().toISOString() };
    this.servers = [...this.servers, server];
    this.onChange?.();
    return { server };
  }

  update(id: string, input: McpServerInput): { error: string } | { server: McpServerConfig } {
    const current = this.get(id);
    if (!current) return { error: "No such MCP server." };
    const checked = validateMcpServer(
      { ...current, ...input },
      this.servers.filter((s) => s.id !== id),
    );
    if ("error" in checked) return checked;
    // A changed command, args or env invalidates the previous verification: what was proven to
    // list tools was the OLD configuration, and carrying the badge over would be exactly the
    // "configured, not verified" claim this feature exists to avoid making.
    const sameLaunch =
      current.command === checked.value.command &&
      JSON.stringify(current.args) === JSON.stringify(checked.value.args) &&
      JSON.stringify(current.env) === JSON.stringify(checked.value.env);
    const server: McpServerConfig = {
      ...checked.value,
      id: current.id,
      createdAt: current.createdAt,
      lastVerified: sameLaunch ? current.lastVerified : undefined,
    };
    this.servers = this.servers.map((s) => (s.id === id ? server : s));
    this.onChange?.();
    return { server };
  }

  remove(id: string): boolean {
    const next = this.servers.filter((s) => s.id !== id);
    if (next.length === this.servers.length) return false;
    this.servers = next;
    this.onChange?.();
    return true;
  }

  recordVerification(id: string, tools: string[]) {
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, lastVerified: { at: new Date().toISOString(), tools } } : s));
    this.onChange?.();
  }

  /** Drop an agent from every per-agent scope. Called when an agent is removed, so a scope
   * does not accumulate dead ids that silently re-attach if an id is ever reused. */
  forgetAgent(agentId: string) {
    let changed = false;
    this.servers = this.servers.map((s) => {
      if (s.scope.kind !== "agents" || !s.scope.agentIds.includes(agentId)) return s;
      changed = true;
      return { ...s, scope: { kind: "agents", agentIds: s.scope.agentIds.filter((a) => a !== agentId) } };
    });
    if (changed) this.onChange?.();
  }
}

/* -------------------------------------------------------------------------- */
/* Live verification                                                           */
/* -------------------------------------------------------------------------- */

export interface McpTestResult {
  ok: boolean;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
  /** Anything the server wrote to stderr, trimmed. The single most useful thing to show when
   * a launch fails: "command not found", "missing API key", a Python traceback. */
  stderr?: string;
}

/**
 * Actually spawn the server and ask it for its tools.
 *
 * This is the "verified, not merely configured" step, and it is a real MCP client handshake -
 * initialize, notifications/initialized, tools/list - not a "did the process stay alive for a
 * second" check. A server that starts fine and then rejects the handshake (wrong entry point,
 * missing key) is precisely the case that a liveness check passes and a real turn then fails
 * on, with the failure buried in a CLI's startup noise.
 *
 * Timeboxed and tree-killed for the reason the plan calls out: a user MCP server that hangs on
 * startup must not be able to hang anything. The same discipline the adapters already apply to
 * the CLIs themselves.
 */
export async function testMcpServer(spec: ResolvedMcpServer, timeoutMs = 20_000): Promise<McpTestResult> {
  return new Promise<McpTestResult>((resolve) => {
    let child;
    try {
      child = spawnCli(spec.command, spec.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // The server's own env on top of ours: an MCP server routinely needs PATH, HOME and
        // the rest to find its own runtime, so this augments rather than replaces.
        env: { ...process.env, ...spec.env },
      });
    } catch (err) {
      resolve({ ok: false, tools: [], error: `failed to start: ${(err as Error).message}` });
      return;
    }

    let stderr = "";
    let buffer = "";
    let settled = false;
    const finish = (result: McpTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killCliTree(child);
      } catch {
        /* already gone */
      }
      resolve({ ...result, stderr: stderr.trim().slice(0, 2000) || undefined });
    };

    const timer = setTimeout(
      () => finish({ ok: false, tools: [], error: `the server did not answer an MCP handshake within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: Error) => finish({ ok: false, tools: [], error: `failed to start: ${err.message}` }));
    child.on("close", (code: number | null) => {
      finish({ ok: false, tools: [], error: `the server exited (code ${code ?? "unknown"}) before listing its tools` });
    });

    const send = (msg: unknown) => child.stdin?.write(`${JSON.stringify(msg)}\n`);
    let serverInfo: McpTestResult["serverInfo"];

    child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString();
      // MCP stdio framing is newline-delimited JSON. A server that writes anything else on
      // stdout (a banner, a log line) is tolerated by skipping unparseable lines rather than
      // failing the test - several real servers do exactly that on first run.
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          finish({ ok: false, tools: [], error: msg.error.message ?? "the server rejected the MCP handshake" });
          return;
        }
        if (msg.id === 1) {
          serverInfo = (msg.result?.serverInfo as McpTestResult["serverInfo"]) ?? undefined;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools)
            ? (msg.result.tools as Array<{ name?: string }>).map((t) => t.name).filter((n): n is string => typeof n === "string")
            : [];
          finish({ ok: true, tools, serverInfo });
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        // The version the five CLIs this app drives all still negotiate. A server that wants a
        // newer one answers with its own, which we accept - we only read serverInfo and tools.
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "solace", version: "0.1.0" },
      },
    });
  });
}
