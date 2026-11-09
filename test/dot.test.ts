import assert from "node:assert/strict";
import { test } from "node:test";
import { appTools, chat, defineDot, defineTool, gate, local, memorySink, memoryStore, redactor, type ChatModel, type VoiceProvider } from "../src/server/index.ts";
import { declarations } from "../src/gemini-live/index.ts";

const SESSION = "0123abcd-0000";
const ADAM = "adam@example.com";

const voice: VoiceProvider = { name: "fake", mint: async (s) => ({ token: "t", persona: s.persona, tools: s.tools.length }) };

const ran: unknown[] = [];
const tools = local([
  defineTool({ name: "pipeline", description: "The deal pipeline. Latest stage per deal.", run: () => ({ deal: "Larkspur", value: "$15,000", contact: "pat@larkspur.example" }) }),
  defineTool({ name: "bank", kind: "private", description: "Balances.", run: () => ({ ok: 1 }) }),
  defineTool({ name: "log_time", kind: "act", description: "Log hours.", run: (a) => (ran.push(a), { logged: a.duration }) }),
  defineTool({ name: "show_link", kind: "display", description: "Show a link.", run: () => ({ url: "https://x.example/?token=abcdef123456" }) }),
  defineTool({ name: "deep_think", kind: "slow", description: "Ask a sub-agent.", run: async () => ({ answer: "retry it" }) }),
]);

async function dot(live = true, receipts: { gapMs?: number; refusals?: number } = { gapMs: 0 }) {
  const traces = memorySink();
  const d = await defineDot({
    name: "test",
    persona: ({ capabilities, codebook, demo }) => `${demo ? "SAFE" : "PRIVATE"}\n${capabilities}\n${codebook}`,
    voice,
    tools: [tools],
    identity: async (req) => req.headers.get("x-login"),
    logins: [ADAM],
    redact: { codenames: { Larkspur: "Acme" } },
    traces,
    live,
    receipts,
  });
  const call = async (name: string, args: Record<string, unknown> = {}, opts: { safe?: boolean; who?: string } = {}) => {
    const res = await d.fetch(
      new Request("http://dot/api/tool", {
        method: "POST",
        headers: opts.who ? { "x-login": opts.who } : {},
        body: JSON.stringify({ name, args, safe: opts.safe ?? true, session: SESSION }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { d, call, traces };
}

test("demo mode redacts amounts, emails and client names", async () => {
  const { call } = await dot();
  const { body } = await call("pipeline");
  assert.deepEqual(body, { deal: "Acme", value: "$•••", contact: "•••@•••" });
});

test("private mode keeps amounts but still needs a login", async () => {
  const { call } = await dot();
  assert.equal((await call("pipeline", {}, { safe: false })).status, 403);
  const { body } = await call("pipeline", {}, { safe: false, who: ADAM });
  assert.equal(body.value, "$15,000");
  assert.equal(body.contact, "•••@•••");
});

test("private-only tools refuse in demo mode", async () => {
  const { call } = await dot();
  assert.match((await call("bank", {}, { who: ADAM })).body.error, /private-mode only/);
});

test("an act runs only after a read-back of the same arguments", async () => {
  const { call } = await dot();
  ran.length = 0;
  assert.equal((await call("log_time", { duration: "1h", confirmed: true })).status, 403);

  const rb = await call("log_time", { duration: "1h" }, { who: ADAM });
  assert.equal(rb.body.readback.action, "log_time");
  assert.equal(ran.length, 0);

  const changed = await call("log_time", { duration: "2h", confirmed: true }, { who: ADAM });
  assert.match(changed.body.readback.say, /^Not sent yet/, "a changed draft gets its own read-back, not a run");
  assert.equal(ran.length, 0);

  const ok = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.deepEqual(ok.body, { logged: "1h" });
  assert.equal(ran.length, 1, "the normal flow runs once");

  const again = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.match(again.body.readback.say, /^Not sent yet/, "a yes is spent once");
  assert.equal(ran.length, 1);
});

test("a confirmed call with no receipt reads back instead of running, and the next yes matches", async () => {
  const { call } = await dot();
  ran.length = 0;
  const first = await call("log_time", { duration: "3h", confirmed: true }, { who: ADAM });
  assert.equal(first.body.error, undefined);
  assert.equal(first.body.readback.action, "log_time");
  assert.deepEqual(first.body.readback.args, { duration: "3h" });
  assert.equal(first.body.readback.text, "log time, duration: 3h");
  assert.match(first.body.readback.say, /^Not sent yet\. Read this exact text back/);
  assert.equal(ran.length, 0, "not run");
  const yes = await call("log_time", { duration: "3h", confirmed: true }, { who: ADAM });
  assert.deepEqual(yes.body, { logged: "3h" });
  assert.equal(ran.length, 1);
});

test("two confirmed calls in the same turn don't run the act", async () => {
  ran.length = 0;
  // By turn, as the chat loop sets it.
  const store = memoryStore();
  const S = "0123abcd-0001";
  assert.ok("readback" in (await gate(store, S, "log_time", { duration: "1h", confirmed: true }, { turn: "t1" })));
  const same = await gate(store, S, "log_time", { duration: "1h", confirmed: true }, { turn: "t1" });
  assert.equal(same.run, false);
  assert.match((same as any).readback.say, /Not sent yet/);
  assert.equal((await gate(store, S, "log_time", { duration: "1h", confirmed: true }, { turn: "t2" })).run, true, "the next turn's yes runs it");

  // By time, as the voice screen gets it: no turn, so the default gap holds.
  const { call } = await dot(true, {});
  await call("log_time", { duration: "1h" }, { who: ADAM });
  const quick = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.match(quick.body.readback.say, /Not sent yet/);
  assert.equal(ran.length, 0, "not run");
});

test("the chat loop won't run an act the model confirms in the same turn", async () => {
  ran.length = 0;
  const model: ChatModel = {
    name: "eager",
    async turn({ history }) {
      const last = history.at(-1)!;
      // Reads back in its own words and confirms at once, each step of the turn.
      if (last.role === "user" || (last.role === "tool" && history.filter((m) => m.role === "tool").length < 2))
        return { calls: [{ id: "c", name: "log_time", args: { duration: "1h", confirmed: true } }] };
      return { text: "Logging an hour, ok?" };
    },
  };
  const d = await defineDot({ name: "t", persona: () => "p", voice, tools: [tools], logins: [ADAM], live: true, receipts: { gapMs: 0 } });
  const c = chat({ dot: d, model, store: memoryStore(), surface: "text" });
  const ctx = { session: SESSION, who: ADAM, demo: true };
  await c.turn(ctx, "log an hour");
  assert.equal(ran.length, 0, "same turn: not run");
  await c.turn(ctx, "yes");
  assert.equal(ran.length, 1, "the yes in the next turn runs it once");
});

test("after two refused confirmed calls the tool stops, and the model is told to stop", async () => {
  const { call } = await dot();
  ran.length = 0;
  const a = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  const b = await call("log_time", { duration: "one hour", confirmed: true }, { who: ADAM });
  assert.ok(a.body.readback && b.body.readback, "two refusals still read back");
  const c = await call("log_time", { duration: "an hour", confirmed: true }, { who: ADAM });
  assert.match(c.body.error, /^STOP\./);
  assert.match(c.body.error, /did not go through/);
  assert.match(c.body.error, /^STOP\. log_time was refused 3 times/);
  assert.match(c.body.error, /Don't retry/);
  // Off for this session, even with a matching yes.
  const late = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.match(late.body.error, /^STOP\./);
  assert.match((await call("log_time", { duration: "1h" }, { who: ADAM })).body.error, /^STOP\./);
  assert.equal(ran.length, 0);
});

test("a run clears the refusals, so honest misses spread over a session don't add up", async () => {
  const { call } = await dot();
  ran.length = 0;
  for (const d of ["1h", "2h", "3h"]) {
    await call("log_time", { duration: d + "x", confirmed: true }, { who: ADAM }); // a miss: reads back
    await call("log_time", { duration: d }, { who: ADAM });
    await call("log_time", { duration: d, confirmed: true }, { who: ADAM });
  }
  assert.equal(ran.length, 3);
});

test("act rules reach the persona, and acts declare confirmed", async () => {
  const { d } = await dot();
  assert.match(await d.persona(true, "voice"), /ALWAYS call the action first WITHOUT confirmed/);
  assert.match(await d.persona(true, "voice"), /word for word, never your own paraphrase/);
  const decl = d.registry.decls.find((x) => x.name === "log_time")!;
  assert.equal(decl.parameters!.properties!.confirmed.type, "boolean");
  assert.equal(d.registry.decls.find((x) => x.name === "pipeline")!.parameters, undefined, "other kinds are left alone");
});

test("acts dry-run unless the dot is live", async () => {
  const { call } = await dot(false);
  await call("log_time", { duration: "1h" }, { who: ADAM });
  const { body } = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.equal(body.dry_run, true);
});

test("display results reach the screen unredacted, for allowed logins only", async () => {
  const { call } = await dot();
  assert.equal((await call("show_link")).status, 403);
  assert.equal((await call("show_link", {}, { who: ADAM })).body.url, "https://x.example/?token=abcdef123456");
});

test("slow tools return a job, then the redacted result", async () => {
  const { d, call } = await dot();
  const { body } = await call("deep_think", { question: "why" });
  assert.equal(body.status, "working");
  await new Promise((r) => setTimeout(r, 10));
  const res = await d.fetch(new Request(`http://dot/api/job/${body.job}`));
  assert.deepEqual(await res.json(), { status: "done", result: { answer: "retry it" } });
});

test("the persona gets capabilities and the codebook from the declarations", async () => {
  const { d } = await dot();
  const tok = (await (await d.fetch(new Request("http://dot/api/token"))).json()) as Record<string, any>;
  assert.match(tok.persona, /^SAFE/);
  assert.match(tok.persona, /- log_time \(action, needs a yes\): Log hours/);
  assert.match(tok.persona, /- bank \(private mode only\)/);
  assert.match(tok.persona, /- pipeline: The deal pipeline\n/);
  assert.match(tok.persona, /Larkspur is Acme/);
  assert.equal((await d.fetch(new Request("http://dot/api/token?safe=0"))).status, 403);
});

test("traces land in hev dot's format, secrets stripped", async () => {
  const { d, traces } = await dot();
  await d.fetch(
    new Request("http://dot/api/trace", {
      method: "POST",
      body: JSON.stringify({
        session: SESSION,
        events: [
          { kind: "u", id: 1, ts: 1, text: "mail pat@larkspur.example" },
          { kind: "tool", id: 2, ts: 2, name: "pipeline", args: {}, result: { value: "$5" }, ms: 40 },
        ],
      }),
    }),
  );
  const lines = traces.lines.get(SESSION) as any[];
  assert.equal(lines[0].role, "user");
  assert.equal(lines[0].text, "mail •••@•••");
  assert.equal(lines[1].tool_calls[0].name, "pipeline");
  assert.equal(lines[1].tool_calls[0].result, '{"value":"$5"}', "amounts are kept in traces");
});

test("two tool servers can't claim the same name", async () => {
  await assert.rejects(defineDot({ name: "x", persona: () => "", voice, tools: [tools, tools] }), /two tool servers/);
});

test("redactor keeps handles and catches keys", () => {
  const r = redactor();
  assert.deepEqual(r.safe({ id: "sk-abcdefghijklmnop", note: "key sk-abcdefghijklmnop" }), {
    id: "sk-abcdefghijklmnop",
    note: "key •••key•••",
  });
});

test("gemini declarations use upper-case types", () => {
  const [d] = declarations([
    { name: "pipeline", description: "d", parameters: { type: "object", properties: { days: { type: "integer" } } } },
  ]);
  assert.deepEqual(d.parameters, { type: "OBJECT", properties: { days: { type: "INTEGER" } } });
});

test("the build is reported by /api/info and stamped on a session's start in traces", async () => {
  const version = { commit: "0123456789abcdef0123456789abcdef01234567", short: "0123456", built: "2026-10-12T00:00:00.000Z" };
  const traces = memorySink();
  const d = await defineDot({ name: "v", persona: () => "p", voice, tools: [tools], traces, version });
  const info = (await (await d.fetch(new Request("http://dot/api/info"))).json()) as any;
  assert.deepEqual(info.version, version);
  await d.fetch(new Request("http://dot/api/trace", { method: "POST", body: JSON.stringify({ session: SESSION, events: [{ kind: "start", id: "a-1" }, { kind: "u", id: "a-2", text: "hi" }] }) }));
  const lines = traces.lines.get(SESSION) as any[];
  assert.equal(lines[0].text, "session start");
  assert.deepEqual(lines[0].version, version, "the commit survives redaction");
  assert.equal(lines[1].version, undefined);
  const none = await defineDot({ name: "v", persona: () => "p", voice, tools: [tools] });
  assert.equal(((await (await none.fetch(new Request("http://dot/api/info"))).json()) as any).version, null);
});

test("appTools open and close apps through the display policy", async () => {
  const d = await defineDot({ name: "a", persona: () => "p", voice, tools: [appTools({ budget: "when asked about money" })], identity: async (req) => req.headers.get("x-login"), logins: [ADAM] });
  const call = (name: string, args: Record<string, unknown>, who?: string) =>
    d.invoke(name, args, { session: SESSION, who: who ?? null, demo: true });
  assert.equal((await call("open_app", { app: "budget" })).status, 403, "anonymous can't");
  const open = await call("open_app", { app: "budget" }, ADAM);
  assert.equal((open.body as any).app, "budget");
  assert.match(String((await call("open_app", { app: "nope" }, ADAM)).body && ((await call("open_app", { app: "nope" }, ADAM)).body as any).error), /no app/);
  assert.deepEqual((await call("close_app", {}, ADAM)).body, { close_app: true });
  const decl = d.registry.decls.find((x) => x.name === "open_app")!;
  assert.deepEqual(decl.parameters!.properties!.app.enum, ["budget"]);
});
