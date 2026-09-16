/**
 * User-registered MCP servers.
 *
 * This app already spawns one MCP server on every CLI turn - `server/src/mcp/solaceBridge.mjs`,
 * registered under the reserved name "solace" - and each of the five CLI adapters injects it
 * through that CLI's own mechanism (three different merge semantics; see
 * docs/MCP-SERVERS-PLAN.md). These types describe the servers the USER adds, which ride
 * alongside the bridge through those same per-adapter mechanisms.
 *
 * Nothing here is ever written into the user's own CLI config files (~/.claude.json,
 * ~/.codex/config.toml, ~/.gemini/settings.json, ~/.copilot/mcp-config.json). Every injection
 * is per-invocation or a fresh temp file, exactly as the solace bridge already is.
 */

/** stdio only, deliberately. An HTTP/SSE MCP server is a different trust story - it sees
 * whatever the agent sends it, from a machine we do not control - and this shape would imply
 * we had thought that through. When HTTP lands it gets its own transport member and its own
 * consent surface, rather than a url quietly appearing in a "command" field. */
export type McpTransport = "stdio";

/**
 * One environment variable handed to the server process.
 *
 * Two forms, and the distinction is the whole point of this type:
 *  - `value`: a literal, stored in plaintext in `.solace-state.json`. For non-secret config
 *    (a path, a project id, a log level).
 *  - `credentialId`: resolved from the vault (server/core/credentials.ts) at spawn time and
 *    never persisted in the state file at all.
 *
 * MCP servers routinely need a token (a Roblox Open Cloud key, a GitHub PAT), so without the
 * second form the state file would become a second, unprotected credential store - and worse,
 * a token pasted there would not be covered by `listSecretValues()` scrubbing, so an agent
 * echoing it back into chat would persist it into history forever. Vault-referenced values are
 * covered by that scrubbing for free, because the value lives in the vault.
 */
export type McpEnvEntry = { name: string; value: string; credentialId?: undefined } | { name: string; credentialId: string; value?: undefined };

/**
 * Which agents get this server.
 *
 * Per-agent is not a nicety: giving every agent a Roblox server when one agent is doing Studio
 * work puts seven irrelevant tools in every other agent's tool list, which is both noise and a
 * real cost in context for every turn they take.
 */
export type McpServerScope = { kind: "global" } | { kind: "agents"; agentIds: string[] };

export interface McpServerConfig {
  id: string;
  /** The MCP server name agents actually see, and the prefix in every tool id they call
   * (`mcp__<name>__<tool>` for Claude/Qwen, `<name>-<tool>` for Copilot). Constrained to
   * [a-z0-9_-] because those two schemes disagree about what a separator is. */
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: McpEnvEntry[];
  enabled: boolean;
  scope: McpServerScope;
  createdAt: string;
  /** Free text from the user, or the catalogue blurb when added from a tile. */
  note?: string;
  /** Result of the last successful Test: the tool names the server actually reported. Stored
   * so the UI can say "verified, 12 tools" rather than "configured" - this project's standing
   * rule for a connection is that it be verified, not merely configured. Absent means never
   * successfully tested, which the UI states plainly rather than implying a pass. */
  lastVerified?: { at: string; tools: string[] };
}

/** Names the bridges already own for every turn. A user server registered under one of these
 * would shadow the group-chat bridge (or, in "manual" mode, the approval bridge) in whichever
 * adapter merges last - i.e. agents would silently stop being able to talk to each other, or
 * approval prompts would stop arriving. Rejected at the write boundary instead. */
export const RESERVED_MCP_SERVER_NAMES = ["solace", "approval-bridge"] as const;

export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A curated catalogue of suggested servers - the MCP equivalent of providerCatalog.ts, and
 * held to exactly the same standing rule as that file: an entry that cannot be confirmed
 * against the project's OWN current docs is left out, never guessed. A catalogue entry that
 * does not exist is worse than a short catalogue: the user tries it, it fails, and they have
 * no way to tell whether the bug is theirs or ours.
 *
 * Every entry below was verified on the date recorded in its comment, against the source URL
 * recorded with it. These are only pre-filled form values; no server code branches on this
 * list, and anything not here can still be added by hand.
 */
export interface CatalogMcpServer {
  name: string;
  title: string;
  blurb: string;
  command: string;
  args: string[];
  /** Env vars the server requires, with where the value comes from. Shown in the UI as a
   * plain "needs an API key" line rather than left for the user to discover on first failure. */
  requiredEnv?: Array<{ name: string; hint: string }>;
  /** Something must already be running on this machine for the server to work at all (a
   * desktop app, a daemon). Stated in the UI up front for the same reason. */
  needsLocalApp?: string;
  /** Where the entry was verified from. */
  source: string;
  /** Any argument the user must replace before this will work (e.g. a directory path). */
  placeholderArgs?: string[];
  /** Where the entry's own docs give a DIFFERENT invocation on macOS. Recorded rather than
   * silently dropped, because this app runs on Windows and the Windows form is what the
   * command/args above carry - a user on a Mac would otherwise be handed a path that does not
   * exist, with no hint that an official alternative was documented. */
  macos?: { command: string; args: string[] };
}

/**
 * Verified 2026-09-15. Each entry's own source URL is on the entry; the checks were: the
 * project's own README or docs page states this exact stdio command, AND the package is
 * currently published (npm/PyPI version noted in the comment) or ships with the app named.
 *
 * Deliberately NOT here, so nobody re-adds them from memory:
 *  - The archived reference servers (GitHub-via-MCP-reference, GitLab, PostgreSQL, SQLite,
 *    Puppeteer, Slack, Sentry-reference, Redis, Google Drive/Maps, Brave Search, EverArt, AWS
 *    KB Retrieval). All moved to modelcontextprotocol/servers-archived and are no longer
 *    maintained; the README's active list is the seven at the top of this file plus Time.
 *  - Roblox/studio-rust-mcp-server, the standalone Roblox server. Its repo carries an explicit
 *    deprecation notice pointing at the built-in Studio server, which is the entry below. It
 *    also needed a Studio *plugin*; the built-in one does not.
 *  - Context7. The npm package @upstash/context7-mcp is published, but the project's current
 *    official README no longer documents an npx stdio launch - it directs users to a remote
 *    HTTPS endpoint. Every stdio snippet found for it came from third-party aggregators, and
 *    this catalogue does not carry a command no first-party doc states.
 *  - Cloudflare's servers. Confirmed to be remote hosted URL servers, not stdio.
 *  - Figma. Transport not confirmed either way; an unchecked entry is left out.
 *  - The many community Roblox Studio servers. Numerous near-identical forks sharing the same
 *    description text - not first-party and not vetted.
 *
 * One caveat this catalogue cannot verify for the user, and the Test button exists for: the
 * official filesystem README notes that some Windows MCP clients need `cmd /c npx …` rather
 * than a bare `npx`. The entries carry the canonical form their own docs state; whether the
 * particular CLI taking the turn resolves a bare `npx` on Windows is something only actually
 * spawning it can answer.
 */
export const MCP_CATALOG: CatalogMcpServer[] = [
  // create.roblox.com/docs/studio/mcp - the MCP server is now BUILT IN to Roblox Studio; the
  // Windows launcher %LOCALAPPDATA%\Roblox\mcp.bat ships with Studio, so nothing is downloaded.
  // Verified against the docs page (and its source in Roblox/creator-docs, main branch), which
  // gives exactly this Windows JSON and states stdio transport.
  {
    name: "roblox-studio",
    title: "Roblox Studio",
    blurb:
      "Reads and edits the data model of the place you have open in Studio. Built into Studio itself - no plugin and no download.",
    command: "cmd.exe",
    args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
    needsLocalApp:
      "Roblox Studio must be open, with the place you want worked on. Turn it on once in Studio: Assistant \u203a \u2026 \u203a Manage MCP Servers \u203a Enable Studio as MCP server.",
    macos: { command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", args: [] },
    source: "https://create.roblox.com/docs/studio/mcp",
  },

  // modelcontextprotocol/servers, src/filesystem/README.md. npm @modelcontextprotocol/server-filesystem
  // 2026.8.31. At least one allowed directory argument is REQUIRED - the server has no access
  // at all without one, which is the point of it.
  {
    name: "filesystem",
    title: "Filesystem",
    blurb: "File reads and writes, restricted to directories you list here. Official MCP reference server.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\path\\to\\allowed\\dir"],
    placeholderArgs: ["C:\\path\\to\\allowed\\dir"],
    source: "https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md",
  },

  // npm @modelcontextprotocol/server-memory 2026.8.31.
  {
    name: "memory",
    title: "Memory",
    blurb: "A knowledge graph the agent can write notes into and read back in later turns. Official MCP reference server.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },

  // npm @modelcontextprotocol/server-sequential-thinking 2026.8.31.
  {
    name: "sequential-thinking",
    title: "Sequential Thinking",
    blurb: "Structured step-by-step reasoning the model can revise as it goes. Official MCP reference server.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },

  // github.com/ahujasid/blender-mcp, fetched 2026-09-16. NOTE the PyPI package is
  // "mcp-for-blender", NOT "blender-mcp" - the repo name and the package name differ, and
  // guessing from the repo name gives a command that does not exist. The README's own JSON is
  // {"command":"uvx","args":["mcp-for-blender"]}. Active: 28.7k stars, 210 commits, current
  // releases on PyPI. Two-part setup, which is why needsLocalApp is explicit about both halves.
  {
    name: "blender",
    title: "Blender",
    blurb:
      "Builds and edits scenes in a running Blender: create objects, assign materials, set up shaders, render.",
    command: "uvx",
    args: ["mcp-for-blender"],
    needsLocalApp:
      "Two steps, both required: install the addon once with `uvx mcp-for-blender install-addon`, then have Blender open with that addon enabled. Needs uv installed (uvx comes with it).",
    source: "https://github.com/ahujasid/blender-mcp",
  },

  // PyPI mcp-server-fetch 2026.8.18. uvx ships with uv, which is NOT installed by default.
  {
    name: "fetch",
    title: "Fetch",
    blurb: "Fetches a web page and converts it to text. Official MCP reference server.",
    command: "uvx",
    args: ["mcp-server-fetch"],
    needsLocalApp: "Needs uv installed (uvx comes with it). Without it the Test button will report that the command was not found.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },

  // PyPI mcp-server-git 2026.8.18. --repository is documented in src/git/README.md.
  {
    name: "git",
    title: "Git",
    blurb: "Read, search and commit against a local git repository. Official MCP reference server.",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "C:\\path\\to\\repo"],
    placeholderArgs: ["C:\\path\\to\\repo"],
    needsLocalApp: "Needs uv installed (uvx comes with it).",
    source: "https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md",
  },

  // github/github-mcp-server README, main. The Docker form is listed rather than the binary
  // form because the binary has no one-line installer - it is a manual download from Releases,
  // so a catalogue tile for it would be a command pointing at a file the user does not have.
  {
    name: "github",
    title: "GitHub",
    blurb: "Issues, pull requests, code search and repo files on github.com. GitHub's own server, run through Docker.",
    command: "docker",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    requiredEnv: [
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", hint: "github.com/settings/personal-access-tokens/new" },
    ],
    needsLocalApp: "Docker must be installed and running.",
    source: "https://github.com/github/github-mcp-server",
  },

  // microsoft/playwright-mcp README. npm @playwright/mcp 0.0.81, published by Microsoft.
  {
    name: "playwright",
    title: "Playwright",
    blurb: "Drives a real browser - navigate, click, fill forms, read the page. Microsoft's own server.",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    needsLocalApp: "Needs Node 18+. It drives a real browser on this machine, which Playwright downloads on first run.",
    source: "https://github.com/microsoft/playwright-mcp",
  },

  // makenotion/notion-mcp-server README. npm @notionhq/notion-mcp-server 2.5.1, published by Notion.
  {
    name: "notion",
    title: "Notion",
    blurb: "Read and edit Notion pages and databases. Notion's own server.",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    requiredEnv: [
      { name: "NOTION_TOKEN", hint: "Create an integration in Notion's developer portal, then share the pages you want it to reach with that integration." },
    ],
    source: "https://github.com/makenotion/notion-mcp-server",
  },

  // getsentry/sentry-mcp README. npm @sentry/mcp-server 0.39.0. Its engines field requires
  // Node >=22.13, which is stricter than anything else here and is why that is called out.
  {
    name: "sentry",
    title: "Sentry",
    blurb: "Issues, events and stack traces from Sentry. Sentry's own server.",
    command: "npx",
    args: ["@sentry/mcp-server"],
    requiredEnv: [
      { name: "SENTRY_ACCESS_TOKEN", hint: "A Sentry user auth token with org:read, project:read/write, team:read/write, event:write." },
    ],
    needsLocalApp: "Needs Node 22.13 or newer - stricter than the other entries here.",
    source: "https://github.com/getsentry/sentry-mcp",
  },
];
