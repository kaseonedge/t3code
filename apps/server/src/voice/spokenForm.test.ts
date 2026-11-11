import { expect, it } from "vite-plus/test";
import { spokenForm } from "./spokenForm.ts";

it.each([
  [
    "plain text",
    "Got it. Your voice is coming through.",
    ["Got it. Your voice is coming through."],
  ],
  [
    "markdown",
    "## Done\n\n- Fixed **the login bug** in `auth.ts`\n- See [the PR](https://example.test/pr/1)",
    ["Done Fixed the login bug in auth.ts See the PR"],
  ],
  ["code only", "```ts\nconst a = 1;\n```", []],
  [
    "code beside prose",
    "Here is the fix:\n```ts\nconst a = 1;\n```\nIt passes now.",
    ["Here is the fix: It passes now."],
  ],
  ["a bare link", "Details at https://example.test/a/b?c=1 today.", ["Details at a link today."]],
  ["nothing", "   \n", []],
])("says %s the way a person would", (_name, text, spoken) => {
  expect(spokenForm(text)).toEqual(spoken);
});

it("splits a reply into short things to say and stops a long one at a sentence", () => {
  const sentence = "This sentence has exactly seven words in it.";
  const chunks = spokenForm(Array.from({ length: 30 }, () => sentence).join(" "));
  expect(chunks.at(-1)).toBe("The rest is in the thread.");
  expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
  const said = chunks.slice(0, -1).join(" ").split(" ").length;
  expect(said).toBeLessThanOrEqual(80);
  expect(said).toBeGreaterThan(60);
  // One long sentence is still said, not dropped.
  expect(spokenForm(Array.from({ length: 120 }, () => "word").join(" "))).toHaveLength(1);
});
