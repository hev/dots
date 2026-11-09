import assert from "node:assert/strict";
import { test } from "node:test";
import { chat, defineDot, defineTool, local, memorySink, memoryStore, type Call, type ChatModel } from "../src/server/index.ts";
import { contents } from "../src/gemini-live/chat.ts";
import { slack, type SlackEvent } from "../src/slack/index.ts";

const CHANNEL = "C0FACTORY";
const BOT = "UHEVBOT";
const ADAM_SLACK = "UADAM";
const ADAM = "adam@example.com";

const ran: unknown[] = [];
const tools = local([
  defineTool({ name: "floor_status", description: "The factory floor.", run: () => ({ live: 3, client: "Larkspur", cost: "$40" }) }),
  defineTool({ name: "log_time", kind: "act", description: "Log hours.", run: (a) => (ran.push(a), { logged: a.duration }) }),
  defineTool({ name: "show_link", kind: "display", description: "Show a link.", run: () => ({ url: "https://tracker.example/x?token=abcdef123456", label: "TASK-61" }) }),
  defineTool({ name: "deep_think", kind: "slow", description: "Ask a sub-agent.", run: async () => ({ answer: "kill it" }) }),
]);

/** A model that plays a script: each turn either calls tools or says something, based on the last message. */
function scripted(): ChatModel & { systems: string[]; seen: number[] } {
  const systems: string[] = [];
  const seen: number[] = [];
  return {
    name: "scripted",
    systems,
    seen,
    async turn({ system, history }) {
      systems.push(system);
      seen.push(history.length);
      const last = history[history.length - 1];
      if (last.role === "tool") return { text: `got ${JSON.stringify(last.results.map((r) => r.result))}` };
      if (last.role !== "user") return { text: "?" };
      const call = (name: string, args: Record<string, unknown> = {}): { calls: Call[] } => ({ calls: [{ id: name, name, args }] });
      if (/floor/.test(last.text)) return call("floor_status");
      if (/log an hour/.test(last.text)) return call("log_time", { duration: "1h" });
      if (/^yes/.test(last.text)) return call("log_time", { duration: "1h", confirmed: true });
      if (/link/.test(last.text)) return call("show_link");
      if (/why/.test(last.text)) return call("deep_think", { question: last.text });
      return { text: "hello" };
    },
  };
}

async function setup() {
  const traces = memorySink();
  const store = memoryStore();
  const dot = await defineDot({
    name: "t",
    persona: ({ surface }) => `surface=${surface}`,
    voice: { name: "none", mint: async () => ({}) },
    tools: [tools],
    logins: [ADAM],
    redact: { codenames: { Larkspur: "Acme" } },
    traces,
    live: true,
  });
  const model = scripted();
  const posted: Record<string, any>[] = [];
  const s = slack({
    chat: chat({ dot, model, store, surface: "slack" }),
    store,
    botToken: "x",
    channel: CHANNEL,
    users: { [ADAM_SLACK]: ADAM },
    api: async (method, body) => {
      if (method === "auth.test") return { ok: true, user_id: BOT };
      if (method === "chat.postMessage") posted.push(body);
      return { ok: true };
    },
  });
  let n = 0;
  const say = (text: string, o: Partial<SlackEvent> = {}) =>
    s.handle({ type: "app_mention", channel: CHANNEL, user: ADAM_SLACK, text: `<@${BOT}> ${text}`, ts: `100.${++n}`, ...o });
  return { s, say, posted, model, traces };
}

test("a mention in #factory gets the same dot, redacted", async () => {
  const { say, posted, model } = await setup();
  assert.equal(await say("what's on the floor?"), true);
  assert.equal(model.systems[0], "surface=slack");
  assert.equal(posted.at(-1)!.thread_ts, "100.1");
  assert.match(posted.at(-1)!.text, /"live":3/);
  assert.match(posted.at(-1)!.text, /Acme/);
  assert.match(posted.at(-1)!.text, /\$•••/);
});

test("other channels, bots and edits are ignored", async () => {
  const { say, posted } = await setup();
  assert.equal(await say("floor", { channel: "COTHER" }), false);
  assert.equal(await say("floor", { bot_id: "B1" }), false);
  assert.equal(await say("floor", { subtype: "message_changed" }), false);
  assert.equal(posted.length, 0);
});

test("an act reads back in the thread and runs on Adam's yes", async () => {
  const { s, say } = await setup();
  ran.length = 0;
  await say("log an hour to admin");
  assert.equal(ran.length, 0, "the read-back doesn't run it");
  const reply = { type: "message", channel: CHANNEL, thread_ts: "100.1", text: "yes, do it" };
  await s.handle({ ...reply, user: "USTRANGER", ts: "100.2" });
  assert.equal(ran.length, 0, "a yes from someone unmapped doesn't run it");
  await s.handle({ ...reply, user: ADAM_SLACK, ts: "100.3" });
  assert.deepEqual(ran, [{ duration: "1h", confirmed: true }]);
});

test("thread replies need a thread the dot was mentioned in", async () => {
  const { s, posted } = await setup();
  assert.equal(await s.handle({ type: "message", channel: CHANNEL, user: ADAM_SLACK, thread_ts: "999.1", ts: "999.2", text: "floor" }), false);
  assert.equal(posted.length, 0);
});

test("the mention's duplicate message event is answered once", async () => {
  const { say, s } = await setup();
  await say("floor");
  assert.equal(await s.handle({ type: "message", channel: CHANNEL, user: ADAM_SLACK, thread_ts: "100.1", ts: "100.9", text: `<@${BOT}> floor` }), false);
});

test("clear in a thread forgets it and marks the trace", async () => {
  const { s, say, posted, model, traces } = await setup();
  await say("floor");
  const reply = (text: string, ts: string) => s.handle({ type: "message", channel: CHANNEL, user: ADAM_SLACK, thread_ts: "100.1", ts, text });
  assert.equal(await reply("clear", "100.2"), true);
  assert.match(posted.at(-1)!.text, /^Cleared/);
  await reply("hi", "100.3");
  assert.equal(model.seen.at(-1), 1, "the next turn starts with only itself");
  const lines = [...traces.lines.values()][0] as any[];
  assert.ok(lines.some((l) => l.role === "event" && l.text === "cleared"));
});

test("display tools post the link; the model hears it was shown", async () => {
  const { say, posted } = await setup();
  await say("open the link");
  assert.equal(posted[0].text, "<https://tracker.example/x?token=abcdef123456|TASK-61>");
  assert.match(posted.at(-1)!.text, /"shown":true/);
});

test("slow tools say they're working, then answer", async () => {
  const { say, posted } = await setup();
  await say("why is it stuck?");
  assert.match(posted[0].text, /sub-agent/);
  assert.match(posted.at(-1)!.text, /kill it/);
});

test("slack turns are traced in hev dot's format", async () => {
  const { say, traces } = await setup();
  await say("floor");
  const lines = [...traces.lines.values()][0] as any[];
  assert.deepEqual(lines.map((l) => l.role), ["user", "assistant", "assistant"]);
  assert.equal(lines[1].tool_calls[0].name, "floor_status");
});

test("gemini model turns go back as they came, thought signatures and all", () => {
  const raw = [{ functionCall: { name: "floor_status", args: {} }, thoughtSignature: "sig" }];
  assert.deepEqual(contents([{ role: "model", calls: [], raw }])[0], { role: "model", parts: raw });
});

test("gemini contents map calls and results", () => {
  const c = contents([
    { role: "user", text: "hi" },
    { role: "model", calls: [{ id: "1", name: "floor_status", args: {} }] },
    { role: "tool", results: [{ id: "1", name: "floor_status", result: [1, 2] }] },
  ]);
  assert.deepEqual(c[1].parts, [{ functionCall: { name: "floor_status", args: {} } }]);
  assert.deepEqual(c[2].parts, [{ functionResponse: { name: "floor_status", response: { result: [1, 2] } } }]);
});
