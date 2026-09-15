import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTOR_KINDS, connectorKind } from "@solace/shared";

/**
 * CONNECTOR_KINDS is the single list the chooser, the section subheads and the per-kind
 * "how is this checked" line all render from. Its whole value is that a new connector is
 * one entry here rather than three edits in three components, so these guard the shape that
 * makes that true - not the wording.
 */

test("every kind has an id, a title, a blurb and a stated verification", () => {
  for (const k of CONNECTOR_KINDS) {
    assert.ok(k.id.trim().length > 0, "id");
    assert.ok(k.title.trim().length > 0, `${k.id} title`);
    assert.ok(k.blurb.trim().length > 0, `${k.id} blurb`);
    // The important one. A kind with no stated verification is a kind whose dot would mean
    // nothing, which is exactly what this panel was rebuilt to stop.
    assert.ok(k.verification.trim().length > 0, `${k.id} must say what its check actually does`);
  }
});

test("ids are unique", () => {
  const ids = CONNECTOR_KINDS.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate connector kind id");
});

test("the CLI agents are the first kind offered", () => {
  // Not cosmetic: a CLI signed in against the user's own subscription is the differentiator,
  // and it used to be the least prominent row in the panel. If something re-sorts this list,
  // that regression is worth failing a build over.
  assert.equal(CONNECTOR_KINDS[0].id, "cli");
});

test("github is offered as its own kind, not folded into API keys", () => {
  assert.ok(CONNECTOR_KINDS.some((k) => k.id === "github"));
});

test("the vault is the only kind that declares itself uncheckable", () => {
  const uncheckable = CONNECTOR_KINDS.filter((k) => !k.checkable).map((k) => k.id);
  assert.deepEqual(uncheckable, ["vault"]);
});

test("connectorKind throws on an id that is not in the list", () => {
  // A silent fallback here would let the list and the components that render it drift apart
  // without anything noticing - which is the failure mode this file exists to prevent.
  assert.throws(() => connectorKind("not-a-kind" as never), /unknown connector kind/);
  assert.equal(connectorKind("github").id, "github");
});
