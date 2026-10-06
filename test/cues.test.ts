import assert from "node:assert/strict";
import { test } from "node:test";
import { cueRoutes, CUE_LINES } from "../src/cues/index.ts";
import { wav } from "../src/gemini-live/index.ts";
import { screen } from "../src/client/index.ts";

test("cues speak each take once and serve it as WAV", async () => {
  const spoken: string[] = [];
  const c = cueRoutes({ speak: async (t) => (spoken.push(t), new Uint8Array([1, 2, 3])), key: "Sulafat" });
  const get = (q: string) => c.routes(new Request("http://x/api/cue?" + q));
  const r = (await get("kind=ready&n=1"))!;
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(decodeURIComponent(r.headers.get("x-spoken")!), CUE_LINES.ready[1]);
  await get("kind=ready&n=1");
  await Promise.all([get("kind=bye&n=0"), get("kind=bye&n=0")]);
  assert.deepEqual(spoken, [CUE_LINES.ready[1], CUE_LINES.bye[0]]);
  assert.equal((await get("kind=nope"))!.status, 404);
  assert.equal(await c.routes(new Request("http://x/api/token")), null);
});

test("bare PCM gets a 44-byte WAV header", () => {
  const w = wav(new Uint8Array(100));
  assert.equal(w.length, 144);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), "RIFF");
});

test("modes: false hides the demo switch; cues are opt-in", () => {
  assert.match(screen({ name: "x" }), /"modes":true,"cues":false/);
  assert.match(screen({ name: "x", modes: false, cues: true }), /"modes":false,"cues":true/);
});
