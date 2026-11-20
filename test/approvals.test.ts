import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { chat, CONFIRM, defineDot, defineTool, local, memoryConfig, memoryStore, type ChatModel, type ConfigStore, type DotOptions, type VoiceProvider } from "../src/server/index.ts";

const SESSION = "0123abcd-0000";
const ADAM = "adam@example.com";

function fixture(o: Partial<DotOptions> = {}) {
  const ran: Record<string, unknown>[] = [];
  const minted: Record<string, unknown>[] = [];
  const voice: VoiceProvider = { name: "fake", mint: async (s) => (minted.push(s as never), { token: "t" }) };
  const tools = local([
    defineTool({ name: "notes", description: "Read notes.", run: () => ({ notes: ["a"] }) }),
    defineTool({ name: "log_time", kind: "act", description: "Log hours.", run: (a) => (ran.push(a), { logged: a.duration }) }),
    defineTool({ name: "send_mail", kind: "act", description: "Send a mail.", parameters: { type: "object", properties: { to: { type: "string" }, confirmed: { type: "boolean" } }, required: ["to", "confirmed"] }, run: (a) => (ran.push(a), { sent: a.to }) }),
  ]);
  const config = memoryConfig();
  const store = memoryStore();
  const ready = defineDot({
    name: "test",
    persona: ({ capabilities, prompt }) => `PERSONA\n${capabilities}\nPROMPT=${prompt}`,
    voice,
    tools: [tools],
    identity: async (req) => req.headers.get("x-login"),
    logins: [ADAM],
    live: true,
    store,
    config,
    approvals: { gapMs: 0 },
    chatModels: { fast: { name: "fast-model", turn: async () => ({ text: "ok" }) } },
    voices: ["Algenib", "Puck"],
    defaults: { systemPrompt: "Be brief." },
    ...o,
  });
  return ready.then((d) => {
    const call = async (name: string, args: Record<string, unknown> = {}, who: string | null = ADAM, session = SESSION) => {
      const res = await d.fetch(new Request("http://dot/api/tool", { method: "POST", headers: who ? { "x-login": who } : {}, body: JSON.stringify({ name, args, safe: true, session }) }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const decide = async (id: string, decision: string, who: string | null = ADAM, contentType = "application/json") => {
      const headers: Record<string, string> = { "content-type": contentType };
      if (who) headers["x-login"] = who;
      const res = await d.fetch(new Request(`http://dot/api/approvals/${id}`, { method: "POST", headers, body: JSON.stringify({ decision }) }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const getConfig = async (who: string | null = ADAM) => {
      const res = await d.fetch(new Request("http://dot/api/config", { headers: who ? { "x-login": who } : {} }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const putConfig = async (body: unknown, who: string | null = ADAM, contentType = "application/json") => {
      const headers: Record<string, string> = { "content-type": contentType };
      if (who) headers["x-login"] = who;
      const res = await d.fetch(new Request("http://dot/api/config", { method: "PUT", headers, body: JSON.stringify(body) }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { d, call, decide, getConfig, putConfig, ran, minted, config, store };
  });
}

test("ask: an act is held, not run, and answers pending_approval with id, tool, args, summary and expiry", async () => {
  const { call, ran } = await fixture();
  const { status, body } = await call("log_time", { duration: "1h" });
  assert.equal(status, 200);
  assert.equal(ran.length, 0, "not run");
  const p = body.pending_approval;
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.equal(p.tool, "log_time");
  assert.deepEqual(p.args, { duration: "1h" });
  assert.equal(p.summary, "log time · duration: 1h");
  assert.ok(p.expires > Date.now());
  assert.match(body.say, /approval card/);
  assert.doesNotMatch(body.say, /word for word/, "no verbatim read-back");
});

test("ask: the same call again doesn't run it or make a second card", async () => {
  const { call, ran } = await fixture();
  const a = await call("log_time", { duration: "1h" });
  const b = await call("log_time", { duration: "1h", confirmed: true });
  assert.equal(b.body.pending_approval.id, a.body.pending_approval.id, "a retry, even 'confirmed', gets the same approval");
  const c = await call("log_time", { duration: "2h" });
  assert.notEqual(c.body.pending_approval.id, a.body.pending_approval.id, "a changed call is its own approval");
  assert.equal(ran.length, 0);
});

test("ask: approve on the endpoint runs the held call exactly once", async () => {
  const { call, decide, ran } = await fixture();
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  const ok = await decide(id, "approve");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.result, { logged: "1h" });
  assert.deepEqual(ran, [{ duration: "1h" }]);
  const again = await decide(id, "approve");
  assert.equal(again.status, 404, "spent");
  const x = await call("log_time", { duration: "3h" });
  const both = await Promise.all([decide(x.body.pending_approval.id, "approve"), decide(x.body.pending_approval.id, "approve")]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, "two answers racing: one runs");
  assert.equal(ran.length, 2);
});

test("ask: cancel drops the held call and it never runs", async () => {
  const { call, decide, ran } = await fixture();
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  const no = await decide(id, "deny");
  assert.equal(no.body.cancelled, true);
  assert.equal((await decide(id, "approve")).status, 404);
  assert.equal(ran.length, 0);
});

test("always on a pending approval runs it and keeps the rule in the ConfigStore", async () => {
  const { call, decide, ran, config, getConfig } = await fixture();
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  const ok = await decide(id, "always");
  assert.deepEqual(ok.body.result, { logged: "1h" });
  assert.equal((await config.load())?.tools?.log_time?.approval, "always", "persisted");
  assert.equal((await getConfig()).body.config.tools.log_time.approval, "always");
  const next = await call("log_time", { duration: "2h" });
  assert.deepEqual(next.body, { logged: "2h" }, "and from then on it runs without asking");
  assert.equal(ran.length, 2);
});

test("always: a tool set to always runs without blocking", async () => {
  const { call, putConfig, ran } = await fixture();
  assert.equal((await putConfig({ tools: { log_time: { approval: "always" } } })).status, 200);
  const { body } = await call("log_time", { duration: "1h" });
  assert.deepEqual(body, { logged: "1h" });
  assert.equal(ran.length, 1);
  assert.deepEqual((await call("notes")).body, { notes: ["a"] }, "a read tool defaults to always");
});

test("deny refuses execution, even when a held call is approved after the fact", async () => {
  const { call, decide, putConfig, ran } = await fixture();
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  await putConfig({ tools: { log_time: { approval: "deny" } } });
  const late = await decide(id, "approve");
  assert.equal(late.status, 403);
  assert.match(late.body.error, /refused/);
  const always = await call("log_time", { duration: "2h" });
  assert.equal(always.status, 403);
  assert.equal(always.body.denied, true);
  assert.equal((await call(CONFIRM, { id })).status, 409, "and a spoken yes can't either");
  assert.equal(ran.length, 0);
  await putConfig({ tools: { notes: { approval: "deny" } } });
  assert.equal((await call("notes")).status, 403, "deny works on read tools too");
});

test("a disabled tool is hidden from the model and refused", async () => {
  const { d, call, putConfig, minted } = await fixture();
  await putConfig({ tools: { notes: { enabled: false } } });
  assert.equal((await call("notes")).status, 403);
  assert.ok(!(await d.decls()).some((x) => x.name === "notes"));
  assert.doesNotMatch(await d.persona(true, "voice"), /- notes/);
  await d.fetch(new Request("http://dot/api/token"));
  assert.ok(!(minted[0].tools as { name: string }[]).some((x) => x.name === "notes"), "not in the voice session either");
});

test("only an allowed login can approve, and only its own held calls", async () => {
  const { d, call, decide, ran } = await fixture({ logins: [ADAM, "eve@example.com"] });
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  assert.equal((await decide(id, "approve", null)).status, 403, "anonymous");
  assert.equal((await decide(id, "approve", "mallory@example.com")).status, 403, "not allowed");
  assert.equal((await decide(id, "approve", "eve@example.com")).status, 404, "someone else's");
  assert.equal((await decide(id, "approve", ADAM, "text/plain")).status, 415, "a cross-site form post isn't JSON");
  assert.equal((await decide(id, "maybe")).status, 400);
  assert.equal(ran.length, 0);
  assert.equal((await d.fetch(new Request(`http://dot/api/approvals/${id}`, { method: "GET", headers: { "x-login": ADAM } }))).status, 404);
});

test("the model can't approve its own call, change settings, or say always", async () => {
  const { d, call, config, ran } = await fixture({ approvals: {} });
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  // Straight back with the id, without the user's turn in between (voice: inside the gap).
  const quick = await call(CONFIRM, { id, decision: "always" });
  assert.equal(quick.status, 409);
  assert.match(quick.body.error, /not yet/);
  // Args that look like a decision or settings do nothing to the policy.
  await call("log_time", { duration: "1h", decision: "always", approval: "always", tools: { log_time: { approval: "always" } } });
  assert.equal(await config.load(), undefined, "nothing stored");
  // No tool can reach the settings or approval routes: they aren't tools.
  for (const name of ["config", "approvals", "/api/config", "approve"]) assert.match((await call(name, { decision: "always" })).body.error, /unknown tool/);
  assert.equal(ran.length, 0);
  // A tool server can't claim confirm_action.
  await assert.rejects(defineDot({ name: "x", persona: () => "", voice: { name: "v", mint: async () => ({}) }, tools: [local([defineTool({ name: CONFIRM, description: "x", run: () => ({}) })])] }), /framework's own/);
  void d;
});

test("a spoken yes approves once, after the gap, for the same session and login only", async () => {
  // A wide gap, so "too soon" holds on a loaded machine.
  const { call, ran, config } = await fixture({ approvals: { gapMs: 1000 } });
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  assert.equal((await call(CONFIRM, { id })).status, 409, "too soon");
  await new Promise((r) => setTimeout(r, 1050));
  assert.equal((await call(CONFIRM, { id }, ADAM, "0123abcd-9999")).status, 409, "another session");
  assert.equal((await call(CONFIRM, { id }, null)).status, 403, "anonymous");
  const yes = await call(CONFIRM, { id, decision: "always" });
  assert.equal(yes.status, 200);
  assert.equal(yes.body.decision, "approve", "a spoken yes is once, never always");
  assert.deepEqual(ran, [{ duration: "1h" }]);
  assert.equal(await config.load(), undefined);
  assert.equal((await call(CONFIRM, { id })).status, 409, "spent");
});

test("spoken approval can be turned off, leaving only the card", async () => {
  const { d, call } = await fixture({ approvals: { gapMs: 0, voice: false } });
  const p = await call("log_time", { duration: "1h" });
  assert.doesNotMatch(p.body.say, /confirm_action/);
  assert.ok(!(await d.decls()).some((x) => x.name === CONFIRM));
  assert.match((await call(CONFIRM, { id: p.body.pending_approval.id })).body.error, /off/);
});

test("the chat loop: a call and its yes in the same turn don't run; a yes in the next turn runs once", async () => {
  const ran: unknown[] = [];
  let pending = "";
  const model: ChatModel = {
    name: "eager",
    async turn({ history }) {
      const last = history.at(-1)!;
      if (last.role === "user" && /log/.test(last.text)) return { calls: [{ id: "a", name: "log_time", args: { duration: "1h" } }] };
      if (last.role === "tool" && last.results[0].name === "log_time") {
        pending = (last.results[0].result as any).pending_approval.id;
        return { calls: [{ id: "b", name: CONFIRM, args: { id: pending } }] }; // approving itself, same turn
      }
      if (last.role === "user" && /yes/.test(last.text)) return { calls: [{ id: "c", name: CONFIRM, args: { id: pending } }] };
      return { text: "done" };
    },
  };
  const tools = local([defineTool({ name: "log_time", kind: "act", description: "Log hours.", run: (a) => (ran.push(a), { logged: a.duration }) })]);
  const d = await defineDot({ name: "t", persona: () => "p", voice: { name: "v", mint: async () => ({}) }, tools: [tools], logins: [ADAM], live: true, approvals: { gapMs: 0 } });
  const seen: unknown[] = [];
  const c = chat({ dot: d, model, store: memoryStore(), surface: "text" });
  const ctx = { session: SESSION, who: ADAM, demo: true };
  await c.turn(ctx, "log an hour", { onApproval: (_n, p) => void seen.push(p) });
  assert.equal(ran.length, 0, "same turn: not run");
  assert.equal(seen.length, 1, "the surface hears about the card");
  await c.turn(ctx, "yes");
  assert.equal(ran.length, 1, "the next turn's yes runs it once");
});

test("a card answered off the model's view reaches the next typed turn as a note", async () => {
  const seen: string[] = [];
  const model: ChatModel = { name: "m", async turn({ history }) { const l = history.at(-1)!; if (l.role === "user") seen.push(l.text); return { text: "ok" }; } };
  const { d, call, decide } = await fixture({ chatModels: undefined, chat: model });
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  await decide(id, "approve");
  const res = await d.fetch(new Request("http://dot/api/chat", { method: "POST", headers: { "x-login": ADAM }, body: JSON.stringify({ text: "and now?", session: SESSION }) }));
  await res.text();
  assert.match(seen[0], /\[note from the app\] The user approved log time · duration: 1h/);
  assert.match(seen[0], /and now\?$/);
});

test("acts declared for the old read-back keep confirmed out of the model's view, and it's ignored", async () => {
  const { d, call, decide, ran } = await fixture();
  const decl = d.registry.decls.find((x) => x.name === "send_mail")!;
  assert.equal(decl.parameters!.properties!.confirmed, undefined);
  assert.deepEqual(decl.parameters!.required, ["to"]);
  assert.equal(d.registry.decls.find((x) => x.name === "log_time")!.parameters, undefined, "nothing added");
  const id = (await call("send_mail", { to: "x@y", confirmed: true })).body.pending_approval.id;
  await decide(id, "approve");
  assert.deepEqual(ran, [{ to: "x@y" }]);
});

test("acts dry-run unless the dot is live", async () => {
  const { call, decide } = await fixture({ live: false });
  const id = (await call("log_time", { duration: "1h" })).body.pending_approval.id;
  assert.equal((await decide(id, "approve")).body.result.dry_run, true);
});

test("approval rules reach the persona; no read-back rules", async () => {
  const { d, putConfig } = await fixture();
  const p = await d.persona(true, "voice");
  assert.match(p, /- log_time \(needs a yes\)/);
  assert.match(p, /pending_approval/);
  assert.match(p, /confirm_action/);
  assert.doesNotMatch(p, /word for word|confirmed=true/);
  await putConfig({ tools: { log_time: { approval: "always" }, send_mail: { approval: "deny" } } });
  const q = await d.persona(true, "voice");
  assert.match(q, /- log_time: Log hours/);
  assert.match(q, /- send_mail \(refused by the user's settings\)/);
  assert.doesNotMatch(q, /pending_approval/, "no rules when nothing asks");
  assert.ok(!(await d.decls()).some((x) => x.name === CONFIRM));
});

// The configurator's side.

test("GET /api/config: the settings, the defaults, the tools, models and voices; allowed logins only", async () => {
  const { getConfig } = await fixture();
  assert.equal((await getConfig(null)).status, 403);
  assert.equal((await getConfig("mallory@example.com")).status, 403);
  const { body } = await getConfig();
  assert.deepEqual(body.config.identity, { name: "test", icon: "", theme: "", voice: "", model: "" });
  assert.equal(body.config.systemPrompt, "Be brief.");
  assert.deepEqual(body.config.tools.log_time, { enabled: true, approval: "ask" });
  assert.deepEqual(body.config.tools.notes, { enabled: true, approval: "always" });
  assert.deepEqual(body.config.sources, []);
  assert.equal(body.defaults.systemPrompt, "Be brief.");
  assert.deepEqual(body.tools.map((t: any) => t.name), ["notes", "log_time", "send_mail"]);
  assert.deepEqual(body.models, [{ id: "fast", name: "fast-model" }]);
  assert.deepEqual(body.voices, ["Algenib", "Puck"]);
});

test("PUT /api/config keeps identity, prompt, tools and sources, and they take effect on the next turn", async () => {
  const { d, putConfig, getConfig, minted, config } = await fixture();
  const put = await putConfig({
    identity: { name: "Pip", icon: "https://example.com/pip.png", theme: "#336699", voice: "Puck", model: "fast" },
    systemPrompt: "Talk like a sailor.",
    tools: { notes: { enabled: false }, log_time: { approval: "always" } },
    sources: [{ kind: "layer", namespace: "notes" }, { kind: "feed", url: "https://example.com/rss" }],
  });
  assert.equal(put.status, 200);
  const { body } = await getConfig();
  assert.equal(body.config.identity.name, "Pip");
  assert.equal(body.config.systemPrompt, "Talk like a sailor.");
  assert.deepEqual(body.config.tools.notes, { enabled: false, approval: "always" });
  assert.equal(body.config.sources.length, 2);
  // without a restart:
  assert.match(await d.persona(false, "voice"), /PROMPT=Talk like a sailor\./);
  await d.fetch(new Request("http://dot/api/token"));
  assert.equal(minted.at(-1)!.voice, "Puck");
  const info = (await (await d.fetch(new Request("http://dot/api/info"))).json()) as any;
  assert.deepEqual(info.identity, { name: "Pip", icon: "https://example.com/pip.png", theme: "#336699" });
  assert.equal(info.defaultModel, "fast-model");
  assert.ok(!info.tools.some((t: any) => t.name === "notes"));
  assert.deepEqual((await d.config()).sources[0], { kind: "layer", namespace: "notes" });
  // only what changed is stored
  const stored = await config.load();
  assert.deepEqual(Object.keys(stored!).sort(), ["identity", "sources", "systemPrompt", "tools"]);
});

test("PUT /api/config: the prompt resets to the default; a partial patch keeps the rest", async () => {
  const { putConfig, getConfig, config } = await fixture();
  await putConfig({ systemPrompt: "Custom.", identity: { name: "Pip" } });
  await putConfig({ systemPrompt: null });
  const { body } = await getConfig();
  assert.equal(body.config.systemPrompt, "Be brief.");
  assert.equal(body.config.identity.name, "Pip", "untouched");
  assert.equal((await config.load())!.systemPrompt, undefined);
  await putConfig({ systemPrompt: "Be brief." });
  assert.equal((await config.load())!.systemPrompt, undefined, "saving the default is a reset");
});

test("PUT /api/config refuses bad settings whole, and needs an allowed login and JSON", async () => {
  const { putConfig, config } = await fixture();
  const bad: [unknown, RegExp][] = [
    [{ tools: { nope: { approval: "always" } } }, /no tool called nope/],
    [{ tools: { notes: { approval: "sometimes" } } }, /ask, always or deny/],
    [{ tools: { notes: { enabled: "yes" } } }, /true or false/],
    [{ identity: { icon: "javascript:alert(1)" } }, /icon/],
    [{ identity: { icon: "http://insecure.example/x.png" } }, /icon/],
    [{ identity: { theme: "red;}" } }, /hex color/],
    [{ identity: { name: "<script>" } }, /name/],
    [{ identity: { voice: "Mystery" } }, /isn't offered/],
    [{ identity: { model: "gpt-unknown" } }, /isn't offered/],
    [{ sources: { kind: "x" } }, /list/],
    [{ sources: ["x"] }, /object/],
    [{ systemPrompt: 3 }, /string/],
    [{ owner: "me" }, /unknown field/],
    [[1, 2], /object/],
  ];
  for (const [body, why] of bad) {
    // A good change alongside a bad one: neither is kept.
    const r = await putConfig(Array.isArray(body) ? body : { tools: { log_time: { approval: "always" } }, ...(body as object) });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.equal((await putConfig({ systemPrompt: "x" }, null)).status, 403);
  assert.equal((await putConfig({ systemPrompt: "x" }, "mallory@example.com")).status, 403);
  assert.equal((await putConfig({ systemPrompt: "x" }, ADAM, "text/plain")).status, 415);
  assert.equal(await config.load(), undefined, "nothing half-saved");
});

test("a dot with no config store, Layer or identity still works out of the box", async () => {
  const d = await defineDot({ name: "bare", persona: () => "p", voice: { name: "v", mint: async () => ({}) }, tools: [local([defineTool({ name: "hi", description: "Hi.", run: () => ({ hi: 1 }) })])] });
  const res = await d.fetch(new Request("http://dot/api/tool", { method: "POST", body: JSON.stringify({ name: "hi", session: SESSION }) }));
  assert.deepEqual(await res.json(), { hi: 1 });
  assert.equal((await d.fetch(new Request("http://dot/api/config"))).status, 403, "nobody can configure without an identity");
  assert.equal((await d.config()).tools.hi.approval, "always");
});

test("a ConfigStore of the dot's own is used", async () => {
  let saved: unknown;
  const own: ConfigStore = { load: async () => ({ tools: { log_time: { approval: "always" } } }), save: async (c) => void (saved = c) };
  const { call, putConfig } = await fixture({ config: own });
  assert.deepEqual((await call("log_time", { duration: "1h" })).body, { logged: "1h" });
  await putConfig({ identity: { name: "Own" } });
  assert.deepEqual(saved, { tools: { log_time: { approval: "always" } }, identity: { name: "Own" } });
});

test("src/server stays fetch-based: no Node or Workers imports", () => {
  const dir = new URL("../src/server/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /from\s+["'](node:|cloudflare:|fs["']|path["']|http["']|crypto["']|child_process)/, f);
    assert.doesNotMatch(src, /\b(require\(|process\.(env|exit|argv|cwd|nextTick)|Buffer\.|__dirname|setImmediate)/, f);
  }
});
