import { test } from "node:test";
import assert from "node:assert/strict";
import { createProject } from "./workspace";

/**
 * A project name becomes a real directory, so the guard on it is a containment boundary.
 *
 * Found by the routing QA pass and confirmed: the regex was /[<>:"/\|?*...]/ where the `\|` is
 * an escaped PIPE, so backslash was never in the character class at all. `POST /api/projects`
 * with `{"name":"..\\escaped"}` returned 201 and created a directory OUTSIDE the workspace root.
 */
test("a project name cannot escape the workspace root", () => {
  for (const bad of ["..\\escaped", "bad\\name", "..\\..\\deeper", "a\\b\\c"]) {
    assert.throws(() => createProject(bad), /cannot contain/, `${JSON.stringify(bad)} should be refused`);
  }
});

test("the other Windows-illegal characters stay refused", () => {
  // Pinned so a future edit to the class cannot quietly drop one, which is exactly how the
  // backslash went missing.
  for (const bad of ["../escaped", "a/b", "na<me", "na>me", 'na"me', "na|me", "na?me", "na*me", "na:me"]) {
    assert.throws(() => createProject(bad), /cannot contain/, `${JSON.stringify(bad)} should be refused`);
  }
});

test("control characters in a project name are refused", () => {
  // The class intends \x00-\x1f. It contained RAW control bytes rather than the escape text,
  // which is also why git treated workspace.ts as a binary file.
  assert.throws(() => createProject("na\0me"), /cannot contain/);
  assert.throws(() => createProject("na\u001fme"), /cannot contain/);
});

test("an ordinary name with spaces and dots is still allowed", () => {
  // The guard must not become so strict that "Test one" or "v1.2 notes" is rejected - that was
  // a real complaint that led to the rule being loosened in the first place.
  for (const ok of ["Test one", "v1.2 notes", "my-project", "my_project"]) {
    assert.doesNotThrow(() => {
      try {
        createProject(ok);
      } catch (err) {
        // Only a name-validation failure is a test failure here; a filesystem error (the folder
        // already exists, permissions) is environmental and not what this asserts.
        if (/cannot contain|reserved/i.test((err as Error).message)) throw err;
      }
    }, `${JSON.stringify(ok)} should be allowed`);
  }
});
