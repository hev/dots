import assert from "node:assert/strict";
import { test } from "node:test";
import { defineDot, defineTool, local, memorySink, redactor, type VoiceProvider } from "../src/server/index.ts";
import { declarations } from "../src/gemini-live/index.ts";

const SESSION = "0123abcd-0000";
const ADAM = "adam@example.com";

const voice: VoiceProvider = { name: "fake", mint: async (s) => ({ token: "t", persona: s.persona, tools: s.tools.length }) };

const ran: unknown[] = [];
const tools = local([
  defineTool({ name: "pipeline", description: "The deal pipeline. Latest stage per deal.", run: () => ({ deal: "Bristlecone", value: "$15,000", contact: "zach@bcc.example" }) }),
  defineTool({ name: "bank", kind: "private", description: "Balances.", run: () => ({ ok: 1 }) }),
  defineTool({ name: "log_time", kind: "act", description: "Log hours.", run: (a) => (ran.push(a), { logged: a.duration }) }),
  defineTool({ name: "show_link", kind: "display", description: "Show a link.", run: () => ({ url: "https://x.example/?token=abcdef123456" }) }),
  defineTool({ name: "deep_think", kind: "slow", description: "Ask a sub-agent.", run: async () => ({ answer: "retry it" }) }),
]);

async function dot(live = true) {
  const traces = memorySink();
  const d = await defineDot({
    name: "test",
    persona: ({ capabilities, codebook, barsafe }) => `${barsafe ? "SAFE" : "PRIVATE"}\n${capabilities}\n${codebook}`,
    voice,
    tools: [tools],
    identity: async (req) => req.headers.get("x-login"),
    logins: [ADAM],
    redact: { codenames: { Bristlecone: "Acme" } },
    traces,
    live,
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

test("bar-safe redacts amounts, emails and client names", async () => {
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

test("private-only tools refuse in bar-safe mode", async () => {
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
  assert.match(changed.body.error, /no read-back/);
  assert.equal(ran.length, 0);

  const ok = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.deepEqual(ok.body, { logged: "1h" });

  const again = await call("log_time", { duration: "1h", confirmed: true }, { who: ADAM });
  assert.match(again.body.error, /no read-back/, "a yes is spent once");
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
  assert.match(tok.persona, /Bristlecone is Acme/);
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
          { kind: "u", id: 1, ts: 1, text: "mail zach@bcc.example" },
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
