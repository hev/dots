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

test("a dot's design goes in: head tags, CSS after the screen's, decor behind the app", () => {
  const h = screen({ name: "x", design: { head: '<link rel="preconnect" href="https://fonts.gstatic.com">', css: ".wm{color:red}", decor: "<i class=petal></i>" } });
  assert.ok(h.indexOf("fonts.gstatic.com") < h.indexOf("</head>"));
  assert.ok(h.indexOf(".wm{color:red}") > h.indexOf("#toast.on"));
  assert.match(h, /<div id="decor" aria-hidden="true"><i class=petal><\/i><\/div>/);
  assert.doesNotMatch(screen({ name: "x" }), /id="decor"/);
});

test("greeting, sounds and a design script reach the page, and the script still parses", () => {
  const h = screen({ name: "x", greeting: "Open with a haiku.", sounds: { tick: { notes: [[988, 0.08]], type: "triangle" } }, design: { script: "addEventListener('dot:card',()=>{});" } });
  assert.match(h, /"greeting":"Open with a haiku."/);
  assert.match(h, /"sounds":\{"tick":\{"notes":\[\[988,0.08\]\],"type":"triangle"\}\}/);
  const js = h.split("<script>")[1]!.split("</script>")[0]!;
  assert.match(js, /dot:card/);
  assert.doesNotThrow(() => new Function(js));
});
