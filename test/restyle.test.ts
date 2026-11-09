import assert from "node:assert/strict";
import { test } from "node:test";
import { memo } from "../src/server/index.ts";
import { defineDot, local } from "../src/server/index.ts";
import { haikuTools } from "../src/haiku/index.ts";
import { restyleTools, themeProblems, type Sh } from "../src/restyle/index.ts";

test("the gate catches server code and stray imports, even inside the browser script", () => {
  assert.match(themeProblems({ a: 'import { readFileSync } from "node:fs";' }).join(), /node:/);
  assert.match(themeProblems({ a: "export const x = process.env.GEMINI_API_KEY;" }).join(), /process\./);
  assert.match(themeProblems({ a: "script: `${process.env.X}`," }).join(), /process\./);
  assert.match(themeProblems({ a: 'import { sh } from "../src/restyle.ts";' }).join(), /imports \.\.\/src\/restyle\.ts/);
  assert.match(themeProblems({ a: 'import "../src/x.ts";' }).join(), /imports/);
  assert.deepEqual(themeProblems({ a: 'import type { Theme } from "../../index.ts";\nimport { design } from "./design.ts";\nimport type { Palette } from "../../../../dots/src/client/index.ts";' }), []);
});

test("show_haiku wants three lines and puts up a haiku card", async () => {
  const dot = await defineDot({ name: "d", persona: () => "", voice: { name: "x", mint: async () => ({}) }, tools: [local(haikuTools({ title: "俳句", tz: "America/Denver" }))], logins: ["d@x"] });
  const ctx = { session: "0123456789abcdef0123456789abcdef", who: "d@x", demo: false };
  const two = await dot.invoke("show_haiku", { lines: ["a", "b"] }, ctx);
  assert.match(JSON.stringify(two.body), /three lines/);
  const tool = haikuTools({ title: "俳句", tz: "America/Denver" })[0]!;
  const r = (await tool.run({ lines: ["first frost on the pane", "Charlie's swim bag by the door", "the kettle hums on"], about: "a Tuesday" }, ctx)) as { card: { style: string; body: string; title: string } };
  assert.equal(r.card.style, "haiku");
  assert.equal(r.card.body.split("\n").length, 3);
  assert.equal(r.card.title, "俳句");
});

function fakeSh(files: string[], extra: Partial<Record<string, string>> = {}) {
  const calls: string[] = [];
  const sh: Sh = async (bin, args) => {
    calls.push([bin, ...args].join(" "));
    if (bin === "factory" && args[0] === "run") return "started\nabcdef\n";
    if (bin === "factory" && args[0] === "ls") return JSON.stringify([{ id: "abcdef", status: "running", pr: { number: 7 } }]);
    if (bin === "gh" && args[0] === "pr" && args[1] === "view")
      return JSON.stringify({ state: "OPEN", files: files.map((path) => ({ path })), title: "German", url: "https://github.com/you/mydot/pull/7", body: "Your dot can now look like a Bavarian beer garden.\n\nmore" });
    return extra[bin] ?? "";
  };
  return { sh, calls };
}

test("restyle starts an agent and comes back with the PR's one line", async () => {
  const { sh, calls } = fakeSh(["theme/index.ts"]);
  const t = restyleTools({ sh, repo: "you/mydot", who: "Sam", repoDir: "/x/mydot", pollMs: 1 })[0]!;
  const r = (await t.run({ change: "make it German" }, { session: "", who: null, demo: false })) as { pr: number; says: string };
  assert.equal(r.pr, 7);
  assert.equal(r.says, "Your dot can now look like a Bavarian beer garden.");
  assert.match(calls[0]!, /^factory run you\/mydot Restyle Sam's dot[\s\S]*make it German/);
});

test("ship_theme refuses a change past theme/ and web/, before touching git", async () => {
  const { sh, calls } = fakeSh(["theme/index.ts", "src/dot.ts"]);
  const t = restyleTools({ sh, repo: "you/mydot", who: "Sam", repoDir: "/x/mydot" })[1]!;
  assert.equal(t.kind, "act");
  const r = (await t.run({ pr: 7, confirmed: true }, { session: "", who: null, demo: false })) as { error: string; files: string[] };
  assert.match(r.error, /owner ships it/);
  assert.deepEqual(r.files, ["src/dot.ts"]);
  assert.ok(!calls.some((c) => c.startsWith("git") || c.includes("merge")));
});


test("memo shares in-flight calls, keeps answers for a while, never keeps failures", async () => {
  let n = 0;
  const slow = memo(async (x: string) => { n++; if (x === "bad") throw new Error("no"); await new Promise((r) => setTimeout(r, 20)); return x + n; }, 1000);
  const [a, b] = await Promise.all([slow("cal"), slow("cal")]);
  assert.equal(a, "cal1"); assert.equal(b, "cal1");
  assert.equal(await slow("cal"), "cal1");
  await assert.rejects(slow("bad")); await assert.rejects(slow("bad"));
  assert.equal(n, 3);
  slow.clear();
  assert.equal(await slow("cal"), "cal4");
});

test("a null key skips the cache", async () => {
  let n = 0;
  const f = memo(async () => ++n, 1000, { key: () => null });
  await f(); await f();
  assert.equal(n, 2);
});
