import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "./originPolicy";

/**
 * Who may call this API from a browser.
 *
 * The server previously ran `origin: true`, which reflects whatever Origin it is sent - so any
 * website the user visited could read /api/agents, enumerate the credential vault, or create a
 * bypassPermissions agent, using the user's own browser as the way in. None of the /api routes
 * authenticate; this policy is the whole boundary.
 */
test("the app's own origins are allowed", () => {
  for (const o of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4310",
    "https://localhost:8443",
  ]) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
});

test("any other website is refused", () => {
  for (const o of [
    "https://evil.example.com",
    "http://evil.example.com",
    // The classic near-misses: a hostname that merely CONTAINS localhost, or uses it as a
    // subdomain label, is a different host entirely.
    "https://localhost.evil.com",
    "https://notlocalhost",
    "https://127.0.0.1.evil.com",
    "http://192.168.1.80:4310",
  ]) {
    assert.equal(isAllowedOrigin(o), false, o);
  }
});

test("a request with no Origin is allowed", () => {
  // curl, a native client, and same-origin navigations send no Origin. These are not browser
  // cross-origin requests, and refusing them would break the app's own fetches.
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(""), true);
});

test("a malformed Origin is refused rather than parsed optimistically", () => {
  for (const o of ["not a url", "http://", "javascript:alert(1)//localhost"]) {
    assert.equal(isAllowedOrigin(o), false, o);
  }
});
