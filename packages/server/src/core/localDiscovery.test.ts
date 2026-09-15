import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_RUNTIMES, identifyProbeResponse } from "./localDiscovery";

// identifyProbeResponse is the only thing standing between "a port on the user's machine
// answered" and "Solace tells them a model server is running there". A false positive here
// sends a real chat turn to whatever unrelated local service happens to hold that port, so
// the cases below are all about what is NOT enough evidence.

test("a bare 200 with no recognisable body is never 'running'", () => {
  assert.equal(identifyProbeResponse("ollama", 200, {}), "unidentified");
  assert.equal(identifyProbeResponse("ollama", 200, "<html>Apache</html>"), "unidentified");
  assert.equal(identifyProbeResponse("koboldcpp", 200, { result: "something else" }), "unidentified");
  assert.equal(identifyProbeResponse("llamacpp", 200, {}), "unidentified");
  // vLLM's /health and LocalAI's /readyz both answer 200 with nothing distinguishing, so the
  // 200 on its own must never be accepted - this is the AirPlay/Flask/Jenkins false positive.
  assert.equal(identifyProbeResponse("vllm", 200, ""), "unidentified");
  assert.equal(identifyProbeResponse("localai", 200, "OK"), "unidentified");
});

test("ollama is identified by its own /api/version body", () => {
  // This is the literal body the live Ollama on this machine returned.
  assert.equal(identifyProbeResponse("ollama", 200, { version: "0.34.0" }), "running");
  assert.equal(identifyProbeResponse("ollama", 200, { version: 34 }), "unidentified");
});

test("koboldcpp is identified by the KoboldCpp marker, case-insensitively", () => {
  assert.equal(identifyProbeResponse("koboldcpp", 200, { result: "KoboldCpp", version: "1.99" }), "running");
  assert.equal(identifyProbeResponse("koboldcpp", 200, { result: "koboldcpp" }), "running");
});

test("llama.cpp counts as running while it is still loading a model", () => {
  // /health answers 200 {"status":"ok"} once ready and 503 with a status body while loading.
  // Both mean the server is genuinely there, which is what the user is being told.
  assert.equal(identifyProbeResponse("llamacpp", 200, { status: "ok" }), "running");
  assert.equal(identifyProbeResponse("llamacpp", 503, { status: "loading model" }), "running");
  assert.equal(identifyProbeResponse("llamacpp", 503, "Service Unavailable"), "unidentified");
});

test("runtimes with no health endpoint are identified by a real OpenAI model list", () => {
  const list = { object: "list", data: [{ id: "llama-3.1-8b", object: "model" }] };
  for (const id of ["lmstudio", "jan", "gpt4all"]) {
    assert.equal(identifyProbeResponse(id, 200, list), "running");
    assert.equal(identifyProbeResponse(id, 200, { data: [{ name: "x" }] }), "unidentified");
    assert.equal(identifyProbeResponse(id, 200, { models: ["x"] }), "unidentified");
  }
  // An empty list is still a positively-shaped OpenAI response - a server with nothing loaded
  // is running, and refusing to see it would be its own kind of wrong answer.
  assert.equal(identifyProbeResponse("jan", 200, { object: "list", data: [] }), "running");
});

test("vLLM and LocalAI are confirmed only by the follow-up model list", () => {
  const list = { data: [{ id: "mistral-7b" }] };
  assert.equal(identifyProbeResponse("vllm", 200, "", list), "running");
  assert.equal(identifyProbeResponse("localai", 200, "", list), "running");
  assert.equal(identifyProbeResponse("vllm", 200, "", { error: "not found" }), "unidentified");
});

test("401/403 means running-but-authenticated, not absent", () => {
  // Jan, LocalAI, vLLM and LM Studio all support an optional API key; a refusal is evidence
  // something is there, and reporting it as nothing would hide a server the user set up.
  for (const status of [401, 403]) {
    assert.equal(identifyProbeResponse("jan", status, ""), "authenticated");
    assert.equal(identifyProbeResponse("vllm", status, ""), "authenticated");
    assert.equal(identifyProbeResponse("lmstudio", status, ""), "authenticated");
  }
});

test("an unknown runtime id is never identified", () => {
  assert.equal(identifyProbeResponse("not-a-runtime", 200, { version: "1" }), "unidentified");
});

test("the automatic scan never touches 8080, 8000 or 5000", () => {
  // llama.cpp and LocalAI collide with each other on 8080, and 8080/8000/5000 are also
  // Tomcat/Jenkins/webpack, Django/uvicorn, and Flask - plus macOS AirPlay Receiver answers
  // on 5000 with no LLM software installed at all.
  const autoPorts = LOCAL_RUNTIMES.filter((r) => r.autoScan).map((r) => r.defaultPort);
  for (const collided of [8080, 8000, 5000]) {
    assert.ok(!autoPorts.includes(collided), `port ${collided} must be explicit-only`);
  }
  assert.deepEqual([...autoPorts].sort((a, b) => a - b), [1234, 1337, 4891, 5001, 11434]);
});

test("every runtime has a probe path and an OpenAI-compatible api path", () => {
  for (const runtime of LOCAL_RUNTIMES) {
    assert.ok(runtime.probePath.startsWith("/"), `${runtime.id} probePath`);
    assert.ok(runtime.apiPath.startsWith("/"), `${runtime.id} apiPath`);
    assert.ok(runtime.defaultPort > 0 && runtime.defaultPort < 65536, `${runtime.id} port`);
  }
});
