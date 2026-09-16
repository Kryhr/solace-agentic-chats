import { existsSync } from "node:fs";
import * as readline from "node:readline";
import { join } from "node:path";
import { killCliTree, spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * Kimi Code CLI (Moonshot), verified against the installed `@moonshot-ai/kimi-code` 0.43.1.
 *
 * Everything asserted in this file was established against that build - most of it by a REAL
 * headless turn, because Kimi's headless mode differs from its interactive mode in ways its
 * --help does not admit. Turns were run against a local OpenAI-compatible mock provider
 * (kimi supports `type = "openai"` providers with a `base_url`), which is what made it possible
 * to observe real tool execution, real session resumption and the real event stream WITHOUT
 * completing Moonshot's device-code login flow. Nothing here is inferred from documentation.
 *
 * THE HEADLESS MODE IS NOT THE INTERACTIVE MODE. Three findings shape this whole adapter:
 *
 * 1. `-p/--prompt` CANNOT be combined with `--yolo`, `--auto` or `--plan`. All three are
 *    rejected outright before anything runs ("error: Cannot combine --prompt with --yolo.",
 *    and likewise for the other two). The trust flags are interactive-TUI-only.
 *
 * 2. Headless FORCES full autonomy. Kimi's own prompt-mode session setup calls
 *    `setMode("auto")` unconditionally - on a fresh session and again on every resume - and
 *    "auto" is documented in its own --help as "never interrupts you; everything runs and is
 *    decided automatically". Kimi even tells the model so: every headless request carries a
 *    `<system-reminder> Auto permission mode is active. Tool approvals will ...` message.
 *    Verified behaviourally, not just read: a headless turn asked to write a file wrote it, and
 *    one asked to run a shell command ran it, with nobody present to approve either.
 *
 * 3. Permission RULES do not claw that back. A config with explicit
 *    `[[permission.rules]] decision = "deny", pattern = "Write"` (plus Bash and Edit) was
 *    accepted as valid by `kimi doctor` and then IGNORED: the file was still written and the
 *    shell command still ran. Kimi's `auto-mode-approve` policy short-circuits and returns
 *    "approve" before any user-configured deny rule is consulted.
 *
 * So, unlike every other CLI in this directory, Kimi has NO headless trust gradient. See
 * KIMI-REGISTRATION.md for why that means only ONE trust level may be offered for it, and see
 * kimiToolPolicy() below for the one mechanism that does work and why this adapter still
 * cannot use it.
 */

/**
 * Where the npm package keeps its real executable code.
 *
 * `kimi` on PATH is an npm shim pair (`kimi` + `kimi.cmd`). Spawning the .cmd would route the
 * command line through cmd.exe, and a cmd.exe command line is TERMINATED by a literal newline
 * with everything after it silently discarded (see the long note in core/spawnCli.ts). That
 * matters more here than almost anywhere else, because - see buildKimiArgs - Kimi has NO stdin
 * channel for the prompt at all, so the prompt MUST travel in argv, and group prompts are
 * always multi-line.
 *
 * So this adapter does what copilot-cli.ts does for the same reason: it stops going through
 * cmd.exe entirely and spawns `node` (a native .exe) on the package's own entry module.
 * CreateProcess passes argv through verbatim and handles newlines fine. Verified: a three-line
 * prompt sent this way reached the CLI intact.
 *
 * Discovered by walking PATH rather than hardcoding a prefix, so a different npm root or a
 * non-global install still resolves.
 */
export function findKimiEntry(pathValue = process.env.PATH ?? ""): string | undefined {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathValue.split(sep)) {
    if (!dir) continue;
    const entry = join(dir, "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

/**
 * Windows' CreateProcess refuses a command line longer than 32767 characters, and Node surfaces
 * that as `spawn ENAMETOOLONG` - a throw at spawn time, before the CLI ever starts, with no
 * output and nothing in the stream to explain it. That exact failure took this app down once
 * already for the two adapters that put the prompt in argv.
 *
 * Kimi is fully exposed to it, because it has no way to avoid argv:
 *
 *   - `-p/--prompt <prompt>` is a REQUIRED-value option, so the prompt is always an argv
 *     element. It cannot be left to fall through to stdin.
 *   - There is no stdin path for the prompt anywhere in the CLI. Kimi's only uses of
 *     process.stdin are the TUI's raw-mode key reader and the MCP client transport; prompt
 *     mode never reads it. Piping into `kimi -p` does nothing.
 *
 * The real ceiling was measured by binary search against the installed build rather than
 * assumed, and the key result is that the limit is on the WHOLE COMMAND LINE, not on the
 * prompt:
 *
 *   node.exe path + main.mjs path + flags + prompt  ==  32764 characters, maximum.
 *
 * Measured twice with different flag sets: a bare `-p <prompt>` run allowed a 32643-character
 * prompt (121 characters of fixed overhead), and adding `--output-format stream-json -S <id>`
 * allowed 32575 (189 characters of overhead). Both total exactly 32764. That is why the budget
 * below is computed from the ACTUAL argv being sent rather than hardcoded as a prompt length:
 * the overhead varies with the session id, the model alias, and the length of the installed
 * node/package paths, all of which differ per machine and per turn.
 */
export const KIMI_COMMAND_LINE_MAX = 32764;

/**
 * The prompt budget left over for a given command line, or 0 if the fixed parts alone overflow.
 *
 * Deliberately conservative in two ways. Each argv element is counted with a +1 for the space
 * that joins it, and a further margin is NOT subtracted here because the measured 32764 already
 * sits below the documented 32767 - the three-character gap is the observed truth of this
 * build, not a guess, and inventing extra padding on top would silently shrink what users can
 * send for no measured reason.
 */
export function kimiPromptBudget(execPath: string, argsWithoutPrompt: string[]): number {
  const fixed = [execPath, ...argsWithoutPrompt].reduce((n, a) => n + a.length + 1, 0);
  return Math.max(0, KIMI_COMMAND_LINE_MAX - fixed);
}

/**
 * Kimi's own tool-policy section, which is the ONE mechanism that genuinely restricts a
 * headless Kimi turn - and the reason this adapter still cannot offer trust levels.
 *
 * `[tools] disabled = [...]` in config.toml IS enforced, and enforced at execution rather than
 * as a suggestion. Verified with real turns under forced-auto headless mode: with
 * `disabled = ["Write", "Edit", "Bash"]`, a turn that called Write got back
 * `Tool "Write" is disabled by the active tool policy`, a turn that called Bash got the same,
 * and - the part that matters - the file was NOT created and the shell command did NOT run.
 * That is a real capability removal, exactly the shape opencode.ts relies on.
 *
 * It is exported, tested, and unused on purpose. The blocker is not the policy, it is WHERE
 * Kimi will read it from:
 *
 *   - config.toml exists at exactly ONE path: `<KIMI_CODE_HOME>/config.toml`. There is no
 *     project-level config.toml and no --config flag; `resolveConfigPath` is
 *     `join(resolveKimiHome(homeDir), "config.toml")` and nothing else.
 *   - `KIMI_CODE_HOME` relocates the ENTIRE Kimi home, credentials included (the token store is
 *     `join(homeDir, "credentials")`). So pointing it at a per-turn temp directory - the trick
 *     gemini-cli.ts uses via GEMINI_CLI_SYSTEM_DEFAULTS_PATH, which moves only a settings
 *     layer - would also hide the user's Kimi login and leave the CLI unable to run at all.
 *
 * That leaves only writing a tool policy into the user's own ~/.kimi-code/config.toml, which is
 * the line every adapter in this directory holds: that file governs every other kimi run on the
 * machine, including the user's own interactive sessions. Quietly rewriting it per turn is not
 * an option, so the honest outcome is to restrict nothing and OFFER nothing - rather than to
 * present a "plan mode" that silently does not restrain the agent.
 *
 * Kept here, verified and tested, because it is the exact shape the fix needs the day Kimi
 * grows a per-invocation config path (an `--config` flag, or a home override that does not also
 * move credentials). At that point this function is already correct and only the plumbing has
 * to change.
 */
export function kimiToolPolicy(trustLevel: string): string[] {
  switch (trustLevel) {
    case "bypassPermissions":
    case "auto":
      return [];
    case "acceptEdits":
      // Edits go through; the shell and the persistent-schedule tools do not. CronCreate and
      // CronDelete are included because they install work that outlives the turn, which is a
      // strictly larger authority than editing a file in the workspace.
      return ["Bash", "CronCreate", "CronDelete"];
    case "manual":
    case "plan":
    default:
      // Read-only. Collapses onto the SAFE end, as opencode.ts does, so that an unreachable or
      // future trust level can only ever be over-restricted, never over-permitted.
      return ["Write", "Edit", "Bash", "CronCreate", "CronDelete"];
  }
}

/**
 * Pure, so the argv can be asserted on without spawning anything - see kimiArgs.test.ts.
 *
 * The prompt is deliberately NOT a parameter, for the same reason it is left out of
 * buildOpencodeArgs: it keeps the length-checked assembly in one place (runTurn) instead of
 * letting a caller quietly append an unbounded string here.
 *
 * Session handling. Kimi mints its own id (`session_<uuid>`) and there is no flag to propose
 * one, so a first turn carries no session argument and the id is learned from the stream.
 * Resuming uses `-S <id>` and never `-c/--continue`: --continue means "the previous session for
 * this working directory", so two Kimi agents sharing a workspace would silently resume each
 * other's conversation. Verified that `-S <id>` genuinely carries history - a second turn's
 * request contained the first turn's user message AND the first turn's assistant reply, and a
 * third carried all of it again.
 *
 * One real constraint on resuming: Kimi refuses to resume a session from a different directory
 * ("Session ... was created under a different directory."), so a resumed turn must run in the
 * same cwd it was created in. That matches how this app assigns a stable workspace per agent.
 */
export function buildKimiArgs(opts: { entry: string; model?: string; sessionId?: string }): string[] {
  return [
    opts.entry,
    "--output-format",
    "stream-json",
    ...(opts.sessionId ? ["-S", opts.sessionId] : []),
    ...(opts.model ? ["-m", opts.model] : []),
    // No effort/reasoning flag is passed. Kimi has no per-invocation effort option at all - its
    // thinking config is a config.toml section, which this adapter does not write (see
    // kimiToolPolicy). Passing -m for effort, or inventing a flag, would be worse than the
    // honest omission.
  ];
}

/**
 * Kimi's stream-json line shapes, taken from the CLI's own writer and confirmed against real
 * turns. The complete vocabulary is five lines and nothing else:
 *
 *   {"role":"meta","type":"system.version","version":"0.43.1"}
 *   {"role":"assistant","content":"...","tool_calls":[{type,id,function:{name,arguments}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 *   {"role":"meta","type":"turn.step.retrying",...}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...","command":...}
 *
 * Two consequences worth naming, because both are easy to get wrong:
 *
 * - There is NO usage event. Kimi's JSON writer has no branch that emits token counts or cost,
 *   and a real turn whose upstream response carried a full `usage` block still printed nothing.
 *   So this adapter emits no "usage" event ever. Reporting zeros, or deriving numbers from the
 *   prompt, would be inventing figures the provider never gave.
 * - Assistant text is BUFFERED, not streamed. The writer accumulates deltas and flushes one
 *   line at each tool-call/tool-result boundary and at the end of the turn, so "text" events
 *   arrive as a few large blocks rather than token by token. Nothing downstream should read a
 *   pause between them as the agent having stopped.
 *
 * Thinking is dropped entirely in JSON mode (`writeThinkingDelta()` has an empty body), so no
 * "reasoning" event is emitted - there is nothing to emit.
 */
interface KimiLine {
  role?: string;
  type?: string;
  content?: string;
  session_id?: string;
  tool_call_id?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
}

export const kimiAdapter: ProviderAdapter = {
  id: "kimi" as ProviderAdapter["id"],
  async runTurn({ cwd, prompt, model, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const entry = findKimiEntry();
    if (!entry) {
      onEvent({
        type: "error",
        message:
          "Kimi Code CLI not found. Install it with `npm install -g @moonshot-ai/kimi-code`, then run `kimi` once and sign in.",
      });
      onEvent({ type: "done" });
      return;
    }

    const args = buildKimiArgs({ entry, model, sessionId });

    // Checked BEFORE spawning, because spawn ENAMETOOLONG is thrown by the runtime with no
    // output and no indication of which limit was hit - an agent would just appear to fail for
    // no reason. Kimi has no stdin fallback to spill into (see KIMI_COMMAND_LINE_MAX), so
    // there is genuinely nothing to do but refuse, and refusing with the real numbers is what
    // lets a user shorten the input or split the task instead of guessing.
    const budget = kimiPromptBudget(process.execPath, [...args, "-p"]);
    if (prompt.length > budget) {
      onEvent({
        type: "error",
        message:
          `This turn's prompt is ${prompt.length} characters and Kimi can accept at most ${budget} here. ` +
          `Kimi Code has no way to read a prompt from stdin, so the prompt has to travel in the command ` +
          `line, and Windows caps a whole command line at ${KIMI_COMMAND_LINE_MAX} characters. Shorten the ` +
          `message, or split the task across turns.`,
      });
      onEvent({ type: "done" });
      return;
    }

    await new Promise<void>((resolve) => {
      // `node` rather than `kimi`: see findKimiEntry. spawnCli's newline guard stays satisfied
      // for the right reason rather than by accident - it inspects what the command actually
      // resolves to, and node resolves to node.exe, not a shim.
      const child = spawnCli(process.execPath, [...args, "-p", prompt], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Kimi runs an update preflight on every invocation, which can re-exec the CLI
          // mid-turn. A turn is the worst possible moment to swap the binary underneath
          // ourselves, and the user's own `kimi` remains free to update normally.
          KIMI_CODE_NO_AUTO_UPDATE: "1",
        },
      });
      // Nothing is ever written to the child's stdin - Kimi does not read a prompt from it -
      // but the pipe is closed so the child can never block waiting on a handle we own.
      child.stdin?.on("error", () => {});
      child.stdin?.end();

      const rl = readline.createInterface({ input: child.stdout! });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): Kimi spawns MCP server children and background bash tasks of its
        // own, and on Windows killing only the handle we hold leaves those running - real
        // filesystem writes continuing against a turn the user already stopped. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      let reportedSession = sessionId;
      rl.on("line", (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let event: KimiLine;
        try {
          event = JSON.parse(line);
        } catch {
          // NOT a defensive nicety - this genuinely happens. Kimi's Bash tool writes the
          // command's own output straight to the process stdout, interleaved with the JSON
          // stream: a turn running `echo KIMI_RAN_SHELL` printed a bare `KIMI_RAN_SHELL` line
          // between two JSON lines. Surfacing it as text keeps the user's command output
          // visible instead of silently dropping it, and keeps one stray line from derailing
          // the parse of everything after it.
          onEvent({ type: "text", text: line });
          return;
        }

        if (event.role === "meta") {
          if (event.type === "session.resume_hint" && typeof event.session_id === "string") {
            // The only place a session id is ever published. Emitted even when it matches the
            // id we resumed with is avoided, so the caller only stores a genuine change.
            if (event.session_id !== reportedSession) {
              reportedSession = event.session_id;
              onEvent({ type: "session", sessionId: event.session_id });
            }
          } else if (event.type === "turn.step.retrying") {
            // Kimi retrying an upstream failure is not a turn failure - it is still working.
            // Surfaced as text so a long pause has a visible reason rather than looking hung.
            onEvent({ type: "text", text: "(retrying after an upstream error)" });
          }
          // system.version carries only the CLI's own version, which is not the resolved model
          // and is not reported as one. No "model" event is emitted for this provider: no line
          // in the stream carries the model the provider actually used, and echoing back our
          // own -m argument would be presenting our request as the provider's confirmation.
          return;
        }

        if (event.role === "assistant") {
          if (typeof event.content === "string" && event.content) {
            onEvent({ type: "text", text: event.content });
          }
          for (const call of event.tool_calls ?? []) {
            const name = call.function?.name ?? "tool";
            const raw = call.function?.arguments;
            // Kimi sends arguments as a JSON *string*. Parsed so core/toolLabel.ts receives
            // real structured input and can build a human label from the actual values;
            // falls back to the raw string when a partial/malformed payload cannot be parsed.
            let input: unknown = raw;
            if (typeof raw === "string") {
              try {
                input = JSON.parse(raw);
              } catch {
                input = raw;
              }
            }
            onEvent({
              type: "tool-use",
              description: `${name}(${typeof raw === "string" ? raw : JSON.stringify(input ?? {})})`,
              toolName: name,
              input: input ?? {},
            });
          }
          return;
        }

        // role === "tool" is the RESULT of a call already reported above. Not re-emitted as a
        // tool-use, which would double-count every tool call in the UI.
      });

      // Kimi writes real warnings to stderr on otherwise successful turns - the
      // "this folder is not trusted; skipped N project-level MCP server" notice is one - so
      // stderr is never treated as failure on its own; it is only reported if the process also
      // exits non-zero.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          onEvent({ type: "cancelled" });
        } else if (code !== 0) {
          const stderrText = stderrBuffer.trim();
          // The unauthenticated case, verbatim from the real CLI:
          //   "error: failed to run prompt: No model configured. Run `kimi` and use /login to
          //    sign in, then retry; or set default_model in config.toml."
          // Rewritten because the CLI's own advice is subtly wrong for this app's user: the
          // remedy is a one-time sign-in in their own terminal, and `/login` is a slash command
          // typed INSIDE the interactive TUI, not something they can run.
          const message = /No model configured/.test(stderrText)
            ? "Kimi Code is not signed in, so it has no model to use. Run `kimi` in a terminal, sign in with /login, then retry this turn."
            : stderrText || `Kimi Code exited with code ${code}.`;
          onEvent({ type: "error", message });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        onEvent({ type: "error", message: `failed to start Kimi Code CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};
