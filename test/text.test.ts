import assert from "node:assert/strict";
import { test } from "node:test";
import { defineDot, defineTool, local, type ChatModel } from "../src/server/index.ts";

const SESSION = "0123abcd-0000";
const ADAM = "adam@example.com";
const ran: string[] = [];

const tools = local([
  defineTool({ name: "spending", description: "Spending by category. Monthly.", run: (a) => (ran.push("spending"), { dining: "$420", month: a.month }) }),
  defineTool({ name: "pay_bill", kind: "act", description: "Pay a bill.", run: () => (ran.push("pay_bill"), { paid: true }) }),
  defineTool({ name: "show_map", kind: "display", description: "Show a map.", run: () => ({ card: { title: "Home" } }) }),
]);

/** Calls each named tool once, in order, then answers with what came back. */
function model(name: string, plan: string[]): ChatModel & { offered: string[][] } {
  const offered: string[][] = [];
  return {
    name,
    offered,
    async turn({ history, tools }) {
      offered.push(tools.map((t) => t.name));
      const done = history.filter((m) => m.role === "tool").length;
      if (done < plan.length) return { calls: [{ id: `c${done}`, name: plan[done], args: plan[done] === "deep_think" ? { question: "budget?" } : { month: "2026-09" } }] };
      const last = history.at(-1)!;
      return { text: `${name}: ${last.role === "tool" ? JSON.stringify(last.results[0].result) : "hi"}` };
    },
  };
}

async function setup(o: { voice?: string[]; think?: string[] } = {}) {
  const thinker = model("pro", o.think ?? ["spending"]);
  const d = await defineDot({
    name: "me",
    persona: ({ surface }) => `surface=${surface}`,
    voice: { name: "none", mint: async () => ({}) },
    tools: [tools],
    identity: async (req) => req.headers.get("x-login"),
    logins: [ADAM],
    chat: model("flash", o.voice ?? []),
    subagent: { model: thinker, when: "budgets" },
    inbox: "me@example.com",
  });
  const ask = async (text: string, safe = true) => {
    const res = await d.fetch(new Request("http://dot/api/chat", { method: "POST", headers: { "x-login": ADAM }, body: JSON.stringify({ text, session: SESSION, safe }) }));
    return { status: res.status, events: (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };
  return { d, ask, thinker };
}

test("a typed turn streams back a text reply", async () => {
  const { ask } = await setup();
  const { status, events } = await ask("hello");
  assert.equal(status, 200);
  assert.deepEqual(events, [{ reply: "flash: hi" }]);
});

test("display results stream to the screen; the model hears only that they're up", async () => {
  const { ask } = await setup({ voice: ["show_map"] });
  const { events } = await ask("where's home");
  assert.deepEqual(events[0], { display: { card: { title: "Home" } }, name: "show_map" });
  assert.match(events.at(-1).reply, /"shown":true/);
});

test("the sub-agent reads through the dot's tools, never acts, and its answer comes back redacted", async () => {
  const { ask, thinker } = await setup({ voice: ["deep_think"] });
  ran.length = 0;
  const { events } = await ask("how's my budget?");
  assert.deepEqual(events[0], { slow: "deep_think" });
  assert.deepEqual(ran, ["spending"]);
  assert.deepEqual(thinker.offered[0], ["spending"], "no acts, displays or itself");
  assert.match(events.at(-1).reply, /\$•••/);
  assert.doesNotMatch(events.at(-1).reply, /420/);
});

test("private mode in text needs an allowed login", async () => {
  const { d } = await setup();
  const res = await d.fetch(new Request("http://dot/api/chat", { method: "POST", body: JSON.stringify({ text: "hi", session: SESSION, safe: false }) }));
  assert.equal(res.status, 403);
});

test("a dot without a text model says so, and the screen falls back to voice", async () => {
  const d = await defineDot({ name: "x", persona: () => "", voice: { name: "none", mint: async () => ({}) }, tools: [tools] });
  const res = await d.fetch(new Request("http://dot/api/chat", { method: "POST", body: JSON.stringify({ text: "hi", session: SESSION }) }));
  assert.equal(res.status, 404);
});

test("info lists the tools and the inbox", async () => {
  const { d } = await setup();
  const info = (await (await d.fetch(new Request("http://dot/api/info"))).json()) as any;
  assert.equal(info.inbox, "me@example.com");
  assert.deepEqual(info.tools.map((t: any) => [t.name, t.kind]), [["spending", "read"], ["pay_bill", "act"], ["show_map", "display"], ["deep_think", "slow"]]);
  assert.equal(info.tools[0].description, "Spending by category");
});

test("model picker exposes only configured models and rejects unlisted IDs before execution", async () => {
  const chosen: string[] = [];
  const adapter = (name: string): ChatModel => ({ name, turn: async () => { chosen.push(name); return { text: name }; } });
  const d = await defineDot({
    name: "generic", persona: () => "", tools: [],
    voice: { name: "none", mint: async () => ({}) },
    chatModels: { fast: adapter("Fast"), careful: adapter("Careful") },
  });
  const info = await (await d.fetch(new Request("http://dot/api/info"))).json() as any;
  assert.deepEqual(info.models, [{ id: "fast", name: "Fast" }, { id: "careful", name: "Careful" }]);
  for (const id of ["unknown", "toString", "__proto__"]) {
    const r = await d.fetch(new Request("http://dot/api/chat", { method: "POST", body: JSON.stringify({ text: "hi", session: SESSION, model: id }) }));
    assert.equal(r.status, 400);
  }
  assert.deepEqual(chosen, []);
  const r = await d.fetch(new Request("http://dot/api/chat", { method: "POST", body: JSON.stringify({ text: "hi", session: SESSION, model: "careful" }) }));
  assert.match(await r.text(), /Careful/);
  assert.deepEqual(chosen, ["Careful"]);
});

test("switching allowlisted models keeps conversation but drops foreign provider raw data", async () => {
  let history: any[] = [];
  const first: ChatModel = { name: "first", turn: async () => ({ text: "first reply", raw: { signature: "provider-private" } }) };
  const second: ChatModel = { name: "second", turn: async req => { history = req.history; return { text: "second reply" }; } };
  const d = await defineDot({ name: "generic", persona: () => "", tools: [], voice: { name: "none", mint: async () => ({}) }, chatModels: { first, second } });
  for (const model of ["first", "second"]) {
    const r = await d.fetch(new Request("http://dot/api/chat", { method: "POST", body: JSON.stringify({ text: model, model, session: SESSION }) }));
    await r.text();
  }
  assert.equal(history.filter(m => m.role === "user").length, 2);
  const prior = history.find(m => m.role === "model");
  assert.equal(prior.text, "first reply");
  assert.equal(prior.raw, undefined);
});
