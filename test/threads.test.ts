import assert from "node:assert/strict";
import { test } from "node:test";
import { chat, defineDot, memorySink, memoryStore, type ChatModel } from "../src/server/index.ts";

const ADAM = "adam@example.com";
const EVE = "eve@example.com";
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const THUMB = "data:image/jpeg;base64,VEhVTUI=";

async function setup() {
  const store = memoryStore();
  const traces = memorySink();
  const model: ChatModel = { name: "m", turn: async ({ history }) => ({ text: "seen: " + (history.at(-1) as { text: string }).text }) };
  const dot = await defineDot({
    name: "t",
    persona: () => "p",
    voice: { name: "x", mint: async () => ({}) },
    tools: [],
    chat: model,
    identity: async (req) => req.headers.get("x-login"),
    logins: [ADAM, EVE],
    store,
    traces,
  });
  const as = (who: string | null): Record<string, string> => (who ? { "x-login": who } : {});
  const trace = (session: string, events: unknown[], who: string | null = ADAM) =>
    dot.fetch(new Request("http://d/api/trace", { method: "POST", headers: as(who), body: JSON.stringify({ session, events }) }));
  const get = async (path: string, who: string | null = ADAM) => {
    const r = await dot.fetch(new Request("http://d/api" + path, { headers: as(who) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  return { dot, store, traces, model, trace, get, as };
}

test("a user's sessions become threads, newest first, with their first line", async () => {
  const { trace, get } = await setup();
  await trace(A, [{ kind: "start", text: "" }, { kind: "u", text: "how much on coffee\nthis month", ts: 1 }, { kind: "d", text: "About forty.", ts: 2 }, { kind: "tool", name: "spend", result: { x: 1 } }]);
  await new Promise((r) => setTimeout(r, 5));
  await trace(B, [{ kind: "u", text: "", photos: [THUMB, "javascript:alert(1)"] }, { kind: "t", text: "🗂 Blue Bottle", card: { title: "Blue Bottle" } }, { kind: "t", text: "session closed 1006" }]);
  const list = await get("/threads");
  assert.deepEqual(list.body.threads.map((t: any) => [t.id, t.first]), [[B, "📷 photo"], [A, "how much on coffee"]]);
  const a = await get("/threads/" + A);
  assert.deepEqual(a.body.lines.map((l: any) => [l.k, l.text]), [["u", "how much on coffee\nthis month"], ["d", "About forty."]], "only the turns are kept, not tools");
  const b = await get("/threads/" + B);
  assert.deepEqual(b.body.lines[0].photos, [THUMB], "thumbnails are kept, anything else dropped");
  assert.deepEqual(b.body.lines.slice(1).map((l: any) => l.text), ["🗂 Blue Bottle"], "cards and links, not connection noise");
  // A later turn in A moves it to the top and keeps its first line.
  await new Promise((r) => setTimeout(r, 5));
  await trace(A, [{ kind: "u", text: "and tea?" }]);
  assert.deepEqual((await get("/threads")).body.threads.map((t: any) => [t.id, t.first]), [[A, "how much on coffee"], [B, "📷 photo"]]);
});

test("a thread reads back in the screen's mode: demo masks its amounts", async () => {
  const { trace, get } = await setup();
  await trace(A, [{ kind: "u", text: "did the $1,200 rent go out?" }, { kind: "d", text: "Yes, $1,200 on the 1st." }]);
  assert.match((await get("/threads?safe=0")).body.threads[0].first, /\$1,200/);
  assert.match((await get("/threads/" + A + "?safe=0")).body.lines[1].text, /\$1,200/);
  assert.doesNotMatch((await get("/threads")).body.threads[0].first, /1,200/, "demo by default");
  assert.doesNotMatch(JSON.stringify((await get("/threads/" + A + "?safe=1")).body.lines), /1,200/);
});

test("a thread is its owner's alone", async () => {
  const { trace, get } = await setup();
  await trace(A, [{ kind: "u", text: "mine" }]);
  assert.equal((await get("/threads/" + A, EVE)).status, 404);
  assert.deepEqual((await get("/threads", EVE)).body.threads, []);
  await trace(A, [{ kind: "u", text: "eve writes in" }], EVE);
  assert.deepEqual((await get("/threads/" + A)).body.lines.map((l: any) => l.text), ["mine"], "nobody else can add to it");
  assert.equal((await get("/threads", null)).status, 403, "threads need a login");
  await trace(B, [{ kind: "u", text: "anon" }], null);
  assert.equal((await get("/threads/" + B)).status, 404, "anonymous sessions aren't kept");
});

test("typed turns on the screen are kept with their photos; the trace still counts them", async () => {
  const { dot, get, traces, as } = await setup();
  const post = (body: unknown) => dot.fetch(new Request("http://d/api/chat", { method: "POST", headers: as(ADAM), body: JSON.stringify(body) }), undefined, { waitUntil: () => {} });
  await (await post({ session: A, text: "what is this", images: [{ mimeType: "image/jpeg", data: "QUJD", thumb: THUMB }] })).text();
  const lines = (await get("/threads/" + A)).body.lines;
  assert.deepEqual(lines.map((l: any) => [l.k, l.text, l.photos ?? null]), [["u", "what is this", [THUMB]], ["d", "seen: what is this", null]]);
  const u = (traces.lines.get(A) as any[]).find((l) => l.role === "user");
  assert.equal(u.text, "[1 photo] what is this");
  assert.doesNotMatch(JSON.stringify(traces.lines.get(A)), /VEhVTUI/, "thumbnails stay out of the trace");
});

test("other text surfaces don't make screen threads", async () => {
  const { dot, store, model, get } = await setup();
  const slack = chat({ dot, model, store, surface: "slack" });
  await slack.turn({ session: B, who: ADAM, demo: true }, "hi from slack");
  assert.deepEqual((await get("/threads")).body.threads, []);
});
