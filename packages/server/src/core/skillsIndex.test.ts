import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillsIndex } from "./skills";

/**
 * The catalogue an agent is handed.
 *
 * Why this exists at all: agents had NO idea skills were on the machine. The group context block
 * never mentioned them, and only 2 of 96 were installed into any project folder - so an agent
 * asked to build a front end did not know there were front-end skills to read, and two full site
 * builds shipped with no favicon, which one of those skills covers explicitly.
 */
const SKILLS = [
  {
    name: "anti-ai-slop-design",
    sourcePath: "C:\\Users\\x\\.claude\\skills\\anti-ai-slop-design",
    description:
      "Use this skill whenever building, designing, redesigning, or reviewing any website, landing page, web app UI, " +
      "or mobile app UI, even if the user just says build me a site, and apply it before writing any layout.",
  },
  {
    name: "secrets-and-env-hardening",
    sourcePath: "C:\\Users\\x\\.claude\\skills\\secrets-and-env-hardening",
    description: "Use this skill whenever writing code that reads an API key.",
  },
];

test("every skill is listed, and the shared root is stated once instead of 96 times", () => {
  // Repeating the full path on every line cost ~4,800 characters of the block; 76 of the 96
  // real skills sit under one root, so the root is named in the header and the lines carry
  // just the name.
  const index = buildSkillsIndex(SKILLS);
  for (const s of SKILLS) assert.ok(index.includes(s.name), `${s.name} missing`);
  assert.match(index, /SKILL\.md/, "says what to actually open");
  const ROOT = "C:\\Users\\x\\.claude\\skills";
  assert.ok(index.includes(ROOT), "the root is stated");
  assert.equal(index.split(ROOT).length - 1, 1, "and only once");
});

test("a skill outside the main root still prints its own full path", () => {
  // Skills imported from a repo live elsewhere; dropping their path to save space would make
  // them unreadable, which is worse than the bytes saved.
  const outlier = "D:\\repos\\pack\\skills\\from-repo";
  const index = buildSkillsIndex([...SKILLS, { name: "from-repo", sourcePath: outlier, description: "x" }]);
  assert.ok(index.includes(outlier), "outlier keeps its path");
});

test("a long description is truncated, a short one is left alone", () => {
  const index = buildSkillsIndex(SKILLS);
  // The trigger ("Use this skill whenever building...") survives - that is the part that decides
  // whether an agent reaches for it.
  assert.match(index, /Use this skill whenever building, designing/);
  assert.match(index, /…/, "long one is cut");
  assert.ok(index.includes("Use this skill whenever writing code that reads an API key."), "short one is intact");
});

test("it tells the agent to match skills to the work without being asked", () => {
  const index = buildSkillsIndex(SKILLS);
  assert.match(index, /WITHOUT being asked/);
  assert.match(index, /front end/i);
  assert.match(index, /back end/i);
  assert.match(index, /trading|algorithmic/i);
  // Reading all 96 would be its own kind of waste.
  assert.match(index, /Do not read every skill/);
});

test("no skills means no block at all, rather than an empty header", () => {
  // A machine with no skills installed should pay nothing for the feature existing.
  assert.equal(buildSkillsIndex([]), "");
});

test("the count in the header is the real count, not a guess", () => {
  assert.match(buildSkillsIndex(SKILLS), /2 of them/);
  assert.match(buildSkillsIndex([SKILLS[0]]), /1 of them/);
});

test("newlines inside a description cannot break the list structure", () => {
  // Descriptions come from YAML frontmatter on disk and routinely wrap across lines; an
  // unflattened one would put half a blurb on its own line and read as a separate skill.
  const index = buildSkillsIndex([
    { name: "wrapped", sourcePath: "/p", description: "first line\n  second line\n\tthird" },
  ]);
  const body = index.slice(index.indexOf("- wrapped"));
  assert.equal(body.split("\n").filter((l) => l.trim()).length, 1);
  assert.match(index, /first line second line third/);
});
