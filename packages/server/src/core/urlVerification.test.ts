import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { ChatMessage } from "@solace/shared";
import { ChatBus } from "./chatBus";
import { attachUrlVerification, checkLocalUrl, checkLocalUrlsIn } from "./urlVerification";

/**
 * "22 'it's live' claims, 4 contradicted within fifteen messages." The URL checker existed
 * already; its result was a system note in the stream, which only ever appeared for the
 * negative case - so a reader looking at a localhost URL still could not tell a checked one
 * from an unchecked one, and treated all of them as claims.
 *
 * The badge is the fix, and the badge has exactly one rule: **it never appears without a real
 * check behind it.** A tick that is sometimes a guess is worse than no tick, because it teaches
 * the reader to trust every one of them. Most of this file is that rule.
 */

function listen(handler: (status: number) => number): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.statusCode = handler(200);
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, server, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** A port nothing is on. Bound and immediately released, so the number is real and unused
 * rather than a hopeful guess that could collide with something on the test machine. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function agentMessage(text: string, id = "m1"): ChatMessage {
  return {
    id,
    channel: { chatId: "c1" },
    authorId: "agent-a",
    authorHandle: "claude",
    mentions: [],
    text,
    createdAt: new Date().toISOString(),
  };
}

test("a URL that is really serving is badged with the real HTTP status", async () => {
  const up = await listen(() => 200);
  try {
    const check = await checkLocalUrl(`http://127.0.0.1:${up.port}/`);
    assert.ok(check, "a running server must produce a check");
    assert.equal(check!.reachable, true);
    assert.equal(check!.status, 200);
    assert.equal(check!.detail, "HTTP 200");
    // Mandatory, and rendered. A green tick with no time on it is a claim about NOW that a
    // check from four minutes ago cannot make.
    assert.ok(Date.parse(check!.checkedAt) > 0);
  } finally {
    await up.close();
  }
});

test("a port nothing is listening on is badged as a failure, not left blank", async () => {
  const port = await freePort();
  const check = await checkLocalUrl(`http://127.0.0.1:${port}/`);
  assert.ok(check, "a refused connection is an observation and must produce a check");
  assert.equal(check!.reachable, false);
  // The detail is the OS's own error code, not a sentence this app made up about what probably
  // happened - same rule as ConnectionCheck.detail.
  assert.match(check!.detail, /ECONN|EADDR|EHOST|ENET|ENOTFOUND/);
});

test("a badge is never shown without a real check", async () => {
  // THE RULE. Three ways a check can fail to happen, and none of them may produce a badge -
  // not a tick, and not a cross.

  // 1. Nothing that is a localhost URL at all.
  assert.equal(await checkLocalUrl("https://example.com/"), undefined);
  assert.equal(await checkLocalUrl("not a url"), undefined);
  assert.deepEqual(await checkLocalUrlsIn("no urls in this message"), []);

  // 2. A message whose URLs are not loopback. Probing arbitrary hosts an agent named is not
  //    this server's business, so there is no observation to report.
  assert.deepEqual(await checkLocalUrlsIn("deployed to https://prod.example.com/ and it is live"), []);

  // 3. The bus path writes nothing when there is nothing observed - an empty urlChecks array
  //    would be indistinguishable from "checked, found nothing" in the UI.
  const bus = new ChatBus();
  const updates: ChatMessage[] = [];
  bus.subscribe((e) => {
    if (e.type === "chat:message:updated") updates.push(e.payload);
  });
  const detach = attachUrlVerification(bus, { timeoutMs: 500 });
  bus.postMessage(agentMessage("the site is live at https://prod.example.com/"));
  await new Promise((r) => setTimeout(r, 400));
  detach();
  assert.equal(updates.length, 0, "a message with nothing checkable in it must not be badged");
});

test("the badge lands on the message itself, carrying the status and when it was checked", async () => {
  // The old behaviour was a separate system note, which scrolls away from the claim and only
  // ever appeared when the claim was wrong.
  const up = await listen(() => 200);
  const bus = new ChatBus();
  const detach = attachUrlVerification(bus, { timeoutMs: 1500 });
  try {
    const updated = new Promise<ChatMessage>((resolve) => {
      bus.subscribe((e) => {
        if (e.type === "chat:message:updated") resolve(e.payload);
      });
    });
    bus.postMessage(agentMessage(`preview is up at http://127.0.0.1:${up.port}/`));
    const message = await updated;
    assert.equal(message.id, "m1");
    assert.equal(message.urlChecks?.length, 1);
    assert.equal(message.urlChecks![0].status, 200);
    assert.equal(message.urlChecks![0].reachable, true);
    assert.equal(message.urlChecks![0].port, up.port);
  } finally {
    detach();
    await up.close();
  }
});

test("the operator's own messages and system notices are never badged", async () => {
  // The operator knows what they typed. And claimCheck's own "nothing is listening on that
  // port" notice quotes the URL it is reporting as dead - badging that would put a status on
  // Solace's own report about a status.
  const up = await listen(() => 200);
  const bus = new ChatBus();
  const updates: ChatMessage[] = [];
  bus.subscribe((e) => {
    if (e.type === "chat:message:updated") updates.push(e.payload);
  });
  const detach = attachUrlVerification(bus, { timeoutMs: 1000 });
  try {
    const url = `http://127.0.0.1:${up.port}/`;
    bus.postMessage({ ...agentMessage(`check ${url}`, "u1"), authorId: "user", authorHandle: "you" });
    bus.postMessage({ ...agentMessage(`Checked ${url}: nothing is listening.`, "s1"), authorId: "system", authorHandle: "system" });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(updates.length, 0);
  } finally {
    detach();
    await up.close();
  }
});

test("a 500 is still reachable, and says so", async () => {
  // "Something is serving here" and "what it serves is correct" are different questions. The
  // badge answers the first and shows the status so the reader can judge the second - calling a
  // 500 unreachable would be a cross on a server that is demonstrably running.
  const up = await listen(() => 500);
  try {
    const check = await checkLocalUrl(`http://127.0.0.1:${up.port}/`);
    assert.equal(check!.reachable, true);
    assert.equal(check!.status, 500);
  } finally {
    await up.close();
  }
});

test("a message with several localhost URLs gets one check each", async () => {
  const a = await listen(() => 200);
  const deadPort = await freePort();
  try {
    const checks = await checkLocalUrlsIn(
      `the API is on http://localhost:${a.port}/ and the worker is on http://127.0.0.1:${deadPort}/`,
    );
    assert.equal(checks.length, 2);
    assert.equal(checks.find((c) => c.port === a.port)?.reachable, true);
    assert.equal(checks.find((c) => c.port === deadPort)?.reachable, false);
  } finally {
    await a.close();
  }
});
