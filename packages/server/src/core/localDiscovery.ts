import { connect } from "node:net";
import type { LocalServerFinding } from "@solace/shared";

/**
 * Finds OpenAI-compatible model servers running on this machine.
 *
 * This NEVER runs on startup or in the background - only when the user presses "Scan for
 * local servers", or names a runtime explicitly. Probing a user's own loopback ports
 * unprompted is a port scan of their machine; it should be something they asked for, once,
 * and can see the result of.
 *
 * Same discipline as providerStatus.ts's isInstalled(): every probe is async, individually
 * timeboxed and can never throw. Nothing here may block the event loop - that's what broke
 * WebSocket handshakes when provider detection used spawnSync.
 *
 * Two phases, because the expensive part is HTTP and most ports are simply closed:
 *   1. a ~300ms TCP connect, which fails instantly on a closed loopback port;
 *   2. a runtime-specific GET, only for the ports that answered.
 *
 * "Something answered" is deliberately NOT treated as "this runtime is running". An open
 * port proves nothing, and a bare HTTP 200 proves nothing either - plenty of unrelated local
 * software answers 200 on a loopback port. The response body has to actually match the shape
 * that runtime documents. 401/403 is reported separately as "authenticated": Jan, LocalAI,
 * vLLM and LM Studio all support an optional API key, so a refusal means something is there
 * that wants one, not that nothing is.
 */

export type ProbeVerdict = "running" | "authenticated" | "unidentified";

export interface LocalRuntime {
  id: string;
  name: string;
  /** Runtime-specific readiness endpoint, per that project's own docs. */
  probePath: string;
  /** OpenAI-compatible API root, relative to the origin. */
  apiPath: string;
  /** Port used when the user explicitly names this runtime. */
  defaultPort: number;
  /**
   * Whether the button-driven scan may try defaultPort on its own. 8080 (llama.cpp and
   * LocalAI, which also collide with each other), 8000 (vLLM) and 5000 are excluded: those
   * three are the default ports of Tomcat, Jenkins, webpack-dev-server, Django, uvicorn and
   * Flask, and on macOS 5000 is answered by AirPlay Receiver on machines with no LLM
   * software installed at all. Probing them blind produces confident false positives, so
   * they're only reached when the user names that runtime.
   */
  autoScan: boolean;
  /**
   * True when probePath's own response can't identify the runtime (vLLM's /health and
   * LocalAI's /readyz both answer 200 with no distinguishing body), so identification falls
   * through to a second keyless GET of the OpenAI-compatible model list.
   */
  confirmViaModels?: boolean;
}

/** Probe endpoints verified against each runtime's own documentation. */
export const LOCAL_RUNTIMES: LocalRuntime[] = [
  { id: "ollama", name: "Ollama", probePath: "/api/version", apiPath: "/v1", defaultPort: 11434, autoScan: true },
  { id: "lmstudio", name: "LM Studio", probePath: "/v1/models", apiPath: "/v1", defaultPort: 1234, autoScan: true },
  { id: "jan", name: "Jan", probePath: "/v1/models", apiPath: "/v1", defaultPort: 1337, autoScan: true },
  { id: "koboldcpp", name: "KoboldCpp", probePath: "/api/extra/version", apiPath: "/v1", defaultPort: 5001, autoScan: true },
  { id: "gpt4all", name: "GPT4All", probePath: "/v1/models", apiPath: "/v1", defaultPort: 4891, autoScan: true },
  // llama.cpp's server answers /health with 200 once the model is loaded and 503 while it is
  // still loading - 503 is reported as running, because the server is genuinely there and the
  // user's next action (saving a connection) is valid either way.
  { id: "llamacpp", name: "llama.cpp", probePath: "/health", apiPath: "/v1", defaultPort: 8080, autoScan: false },
  { id: "vllm", name: "vLLM", probePath: "/health", apiPath: "/v1", defaultPort: 8000, autoScan: false, confirmViaModels: true },
  { id: "localai", name: "LocalAI", probePath: "/readyz", apiPath: "/v1", defaultPort: 8080, autoScan: false, confirmViaModels: true },
];

/** Always literal 127.0.0.1, never "localhost". GPT4All binds IPv4 only, and on Windows and
 * modern Linux "localhost" resolves to ::1 first - it would be missed entirely. */
const HOST = "127.0.0.1";
const TCP_TIMEOUT_MS = 300;
const HTTP_TIMEOUT_MS = 1500;

function looksLikeOpenAiModelList(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  // An empty list is still a valid, positively-identified OpenAI model list (a server with no
  // model loaded yet), so length isn't required - only that every entry has a string id.
  return data.every((m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string");
}

/**
 * Pure: decides what a probe response actually proves. Kept separate from the I/O so the
 * "an open port is not a running server" rule is directly testable - see localDiscovery.test.ts.
 *
 * `modelsBody` is only consulted for the runtimes whose own health endpoint is not
 * self-identifying (confirmViaModels).
 */
/** Does this body name the runtime it claims to be from? Used only for auth-refusing replies,
 * where the status code alone proves nothing. Deliberately conservative: an empty or unreadable
 * body is not an identification. */
function identifiesItself(runtimeId: string, body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (!text) return false;
  const runtime = LOCAL_RUNTIMES.find((r) => r.id === runtimeId);
  const needles = [runtimeId, runtime?.name ?? ""].filter(Boolean).map((n) => n.toLowerCase());
  const haystack = text.toLowerCase();
  return needles.some((n) => haystack.includes(n));
}

export function identifyProbeResponse(
  runtimeId: string,
  status: number,
  body: unknown,
  modelsBody?: unknown,
): ProbeVerdict {
  const runtime = LOCAL_RUNTIMES.find((r) => r.id === runtimeId);
  if (!runtime) return "unidentified";

  // A 401/403 used to mean "this runtime is here and wants a key" - reported BEFORE any body
  // was looked at. But every HTTP server that refuses anonymous callers answers this way, so a
  // corporate proxy on port 1337 was reported as Jan, with Jan's icon and an Add button, while
  // the panel's own copy above it promised we "only report one when the reply actually
  // identifies that runtime". Verified with a plain server returning 403 and a body saying it
  // had nothing to do with LLMs.
  //
  // An auth-refusing server can only be claimed as a runtime when its own body still names it -
  // which the per-runtime cases below decide. Anything else is unidentified: something is
  // listening, but we cannot say what, and saying nothing is the honest answer.
  if (status === 401 || status === 403) {
    return identifiesItself(runtimeId, body) ? "authenticated" : "unidentified";
  }

  switch (runtimeId) {
    case "ollama":
      // GET /api/version -> {"version":"0.34.0"}
      return status === 200 && typeof (body as { version?: unknown })?.version === "string" ? "running" : "unidentified";

    case "koboldcpp":
      // GET /api/extra/version -> {"result":"KoboldCpp","version":"1.x"}
      return status === 200 && typeof (body as { result?: unknown })?.result === "string" &&
        String((body as { result: string }).result).toLowerCase().includes("kobold")
        ? "running"
        : "unidentified";

    case "llamacpp":
      // GET /health -> {"status":"ok"} when ready, and 503 with a status body while the model
      // is still loading. Both mean the server is there; neither is a bare 200 with no body.
      if (status !== 200 && status !== 503) return "unidentified";
      return typeof (body as { status?: unknown })?.status === "string" ? "running" : "unidentified";

    case "lmstudio":
    case "jan":
    case "gpt4all":
      // These expose no health endpoint, so /v1/models IS the identification: a real
      // OpenAI-shaped list is the evidence, not the 200.
      return status === 200 && looksLikeOpenAiModelList(body) ? "running" : "unidentified";

    default:
      // vLLM (/health) and LocalAI (/readyz) answer 200 with nothing distinguishing, so the
      // 200 alone is worth nothing - the model list has to confirm it.
      if (!runtime.confirmViaModels) return "unidentified";
      if (status !== 200) return "unidentified";
      return looksLikeOpenAiModelList(modelsBody) ? "running" : "unidentified";
  }
}

/** Resolves true only if a TCP connection to the port is accepted within TCP_TIMEOUT_MS.
 * Never rejects - a closed port, a refused connection and a timeout are all just "no". */
function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = connect({ host: HOST, port });
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

interface HttpProbe {
  status: number;
  body: unknown;
}

/**
 * One timeboxed GET. Deliberately minimal: `redirect: "manual"` so a probe can't be walked
 * off-origin, no cookies, and - critically - NO Authorization header ever. A discovery probe
 * talks to a service we have not identified yet; attaching the user's key would hand it to
 * whatever happens to be listening on that port.
 */
async function httpProbe(origin: string, path: string): Promise<HttpProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeRuntime(runtime: LocalRuntime, port: number): Promise<LocalServerFinding | null> {
  const origin = `http://${HOST}:${port}`;
  const probe = await httpProbe(origin, runtime.probePath);
  if (!probe) return null;

  // Only fetched for the runtimes that need it to be identified at all, so an unrelated
  // service on an explicitly-named port gets one extra request, not two for every port.
  const modelsProbe = runtime.confirmViaModels ? await httpProbe(origin, `${runtime.apiPath}/models`) : null;
  const verdict = identifyProbeResponse(runtime.id, probe.status, probe.body, modelsProbe?.body);
  if (verdict === "unidentified") return null;

  const finding: LocalServerFinding = {
    runtime: runtime.id,
    name: runtime.name,
    origin,
    baseUrl: `${origin}${runtime.apiPath}`,
    state: verdict,
    verifiedAt: new Date().toISOString(),
  };

  // Report the models the server itself listed, when it will list them without a key. An
  // "authenticated" server by definition won't, and we never retry one with a key.
  if (verdict === "running") {
    const list = runtime.probePath.endsWith("/v1/models") ? probe : (modelsProbe ?? (await httpProbe(origin, `${runtime.apiPath}/models`)));
    if (list && list.status === 200 && looksLikeOpenAiModelList(list.body)) {
      finding.models = (list.body as { data: { id: string }[] }).data.map((m) => m.id);
    }
  }
  return finding;
}

/**
 * The "Scan for local servers" button. Only touches runtimes marked autoScan, and only after
 * a TCP connect to their default port succeeds. Results are returned, never cached: a local
 * server that answered once is not evidence that it is up now, which is why every finding
 * carries its own verifiedAt instead.
 */
export async function scanForLocalServers(): Promise<LocalServerFinding[]> {
  const candidates = LOCAL_RUNTIMES.filter((r) => r.autoScan);
  const open = await Promise.all(candidates.map((r) => tcpOpen(r.defaultPort)));
  const reachable = candidates.filter((_, i) => open[i]);
  const findings = await Promise.all(reachable.map((r) => probeRuntime(r, r.defaultPort)));
  return findings.filter((f): f is LocalServerFinding => f !== null);
}

/**
 * Probes one runtime the user named explicitly. This is the only way to reach 8080/8000/5000
 * (see LocalRuntime.autoScan) - the user saying "check llama.cpp" is the evidence that makes
 * a positive result on a shared port meaningful.
 */
export async function probeNamedRuntime(runtimeId: string, port?: number): Promise<LocalServerFinding | null> {
  const runtime = LOCAL_RUNTIMES.find((r) => r.id === runtimeId);
  if (!runtime) return null;
  const target = port ?? runtime.defaultPort;
  if (!Number.isInteger(target) || target < 1 || target > 65535) return null;
  if (!(await tcpOpen(target))) return null;
  return probeRuntime(runtime, target);
}
