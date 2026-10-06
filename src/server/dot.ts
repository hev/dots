import { chat, type ChatModel } from "./chat.ts";
import { gate } from "./receipts.ts";
import { redactor, type RedactOptions } from "./redact.ts";
import { memoryStore } from "./stores.ts";
import { think, thinkDecl, type SubagentOptions } from "./think.ts";
import { defineTool, local, registry, type Registry } from "./tools.ts";
import { SESSION, toLines, type ClientEvent } from "./traces.ts";
import type { Ctx, Identity, Pack, Store, ToolServer, TraceSink, VoiceProvider } from "./types.ts";

export type PersonaInput = {
  demo: boolean;
  /** One line per tool, built from the declarations. */
  capabilities: string;
  /** "Real is Codename; ..." for demo mode. */
  codebook: string;
  /** Where the dot is talking: "voice" on the site, or a text surface like "slack". */
  surface: string;
  /** Each pack's guidance, one block per pack. Empty without packs. */
  guidance: string;
};

export type DotOptions = {
  name: string;
  persona: (p: PersonaInput) => string | Promise<string>;
  voice: VoiceProvider;
  tools: ToolServer[];
  /** Integrations plugged in whole: their tools, routes and persona guidance. */
  packs?: Pack[];
  /** A text model for typed turns on the screen (`POST /chat`). Without it, typing goes to the voice session. */
  chat?: ChatModel;
  /** A thinking sub-agent the voice hands judgment questions to, as a slow tool over the dot's read tools. */
  subagent?: SubagentOptions;
  /** The address the dot reads mail from, if it has one, for the screen's info pane. */
  inbox?: string;
  /** Who is calling. Without it, nobody can act or switch demo mode off. */
  identity?: Identity;
  /** Logins allowed to run acts and private mode. */
  logins?: string[];
  redact?: RedactOptions;
  traces?: TraceSink;
  /** Act receipts and slow-job results. Defaults to memory (one process). */
  store?: Store;
  /** When false, confirmed acts answer with what they would have done. Default false. */
  live?: boolean;
  /** Mount point for the routes. Default "/api". */
  base?: string;
  log?: (line: string) => void;
};

type Exec = { waitUntil(p: Promise<unknown>): void };

export type Dot = {
  fetch(req: Request, env?: unknown, exec?: Exec): Promise<Response>;
  registry: Registry;
  /** One tool call through the whole policy: kinds, logins, receipts, redaction. Every surface goes through this. */
  invoke(name: string, args: Record<string, unknown>, ctx: Ctx, exec?: Exec): Promise<{ status: number; body: unknown }>;
  persona(demo: boolean, surface: string): Promise<string>;
  /** Writes trace lines through the configured sink, secrets stripped. */
  trace(session: string, events: ClientEvent[]): Promise<void>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function defineDot(opts: DotOptions): Promise<Dot> {
  const packs = opts.packs ?? [];
  const sub = opts.subagent;
  const subTools = sub
    ? [local([defineTool({ ...thinkDecl(sub), run: async (a, ctx) => think(sub, String(a.question ?? ""), ctx, { tools, invoke, persona: await personaFor(ctx.demo, "subagent") }) })])]
    : [];
  const tools = await registry([...opts.tools, ...packs.map((p) => p.tools), ...subTools]);
  const guidance = packs.filter((p) => p.guidance).map((p) => `${p.name}:\n${p.guidance}`).join("\n\n");
  const r = redactor(opts.redact);
  const store = opts.store ?? memoryStore();
  const logins = new Set(opts.logins ?? []);
  const base = opts.base ?? "/api";
  const log = opts.log ?? (() => {});

  const who = async (req: Request) => (opts.identity ? await opts.identity(req) : null);
  const allowed = (w: string | null) => w !== null && logins.has(w);

  const personaFor = async (demo: boolean, surface: string) =>
    opts.persona({ demo, capabilities: tools.capabilities(), codebook: r.codebook(), surface, guidance });

  async function token(req: Request) {
    const demo = new URL(req.url).searchParams.get("safe") !== "0";
    if (!demo && !allowed(await who(req))) return json({ error: "private mode needs an allowed login" }, 403);
    const persona = await personaFor(demo, "voice");
    // Returned raw: the redactor would mask the token.
    return json(await opts.voice.mint({ persona, tools: tools.decls }));
  }

  async function tool(req: Request, exec?: Exec) {
    const a = (await req.json().catch(() => ({}))) as {
      name?: string;
      args?: Record<string, unknown>;
      safe?: boolean;
      session?: string;
    };
    const ctx: Ctx = { session: String(a.session ?? ""), who: await who(req), demo: a.safe !== false };
    const { status, body } = await invoke(String(a.name ?? ""), a.args ?? {}, ctx, exec);
    return json(body, status);
  }

  async function invoke(name: string, args: Record<string, unknown>, ctx: Ctx, exec?: Exec) {
    const json = (body: unknown, status = 200) => ({ status, body });
    const kind = tools.kind(name);
    const t0 = Date.now();

    if (kind === "private" && ctx.demo) return json({ error: "that's private-mode only; switch demo mode off" });
    if ((kind === "act" || kind === "display" || !ctx.demo) && !allowed(ctx.who)) {
      return json({ error: `not allowed for ${ctx.who ?? "anonymous"}` }, 403);
    }
    if (kind === "act") {
      if (!SESSION.test(ctx.session)) return json({ error: "acts need a session" }, 400);
      const g = await gate(store, ctx.session, name, args);
      if (!g.run) return json(r.safe("error" in g ? { error: g.error } : { readback: g.readback }));
      if (!opts.live) return json({ dry_run: true, would_run: name, args });
    }
    if (kind === "slow") {
      const id = crypto.randomUUID().slice(0, 8);
      await store.put(`job:${id}`, { status: "working" }, 3600);
      const done = tools.call(name, args, ctx).then(
        (out) => store.put(`job:${id}`, { status: "done", result: out, demo: ctx.demo }, 3600),
        (e) => store.put(`job:${id}`, { status: "done", result: { error: String(e) }, demo: ctx.demo }, 3600),
      );
      exec?.waitUntil(done);
      return json({ job: id, status: "working" });
    }

    const out = await tools.call(name, args, ctx);
    const err = out && typeof out === "object" && "error" in out ? (out as { error: unknown }).error : null;
    log(`TOOL ${ctx.who ?? "-"} ${name} ${JSON.stringify(args).slice(0, 120)} ${Date.now() - t0}ms${err ? " ERROR " + String(err).slice(0, 160) : ""}`);
    // A display result is for the screen (a link, a card); redaction would mangle its URLs.
    if (kind === "display") return json(out);
    return json(ctx.demo ? r.demo(out) : r.safe(out));
  }

  /** A typed turn: the same persona, tools and policy, answered in text. Streams NDJSON: {slow}, {display}, then {reply} or {error}. */
  async function talk(req: Request, exec?: Exec) {
    if (!text) return json({ error: "this dot has no text model" }, 404);
    const a = (await req.json().catch(() => ({}))) as { text?: string; session?: string; safe?: boolean };
    const session = String(a.session ?? "");
    if (!SESSION.test(session)) return json({ error: "bad session" }, 400);
    const said = String(a.text ?? "").trim().slice(0, 4000);
    if (!said) return json({ error: "say something" }, 400);
    const ctx: Ctx = { session, who: await who(req), demo: a.safe !== false };
    if (!ctx.demo && !allowed(ctx.who)) return json({ error: "private mode needs an allowed login" }, 403);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const send = (o: unknown) => w.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));
    const done = text
      .turn(ctx, said, { onSlow: (name) => send({ slow: name }), onDisplay: (name, result) => send({ display: result, name }) })
      .then((reply) => send({ reply }), (e) => send({ error: String(e).slice(0, 300) }))
      .finally(() => w.close());
    exec?.waitUntil(done);
    return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
  }

  /** What the screen's info pane shows: the tools, in the persona's own words, and the inbox. */
  function info() {
    return json({
      name: opts.name,
      inbox: opts.inbox ?? null,
      text: !!opts.chat,
      tools: tools.decls.map((d) => ({ name: d.name, kind: d.kind ?? "read", description: d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "") })),
    });
  }

  async function job(id: string) {
    const j = (await store.get(`job:${id}`)) as { status: string; result?: unknown; demo?: boolean } | undefined;
    if (!j) return json({ error: "no such job" }, 404);
    if (j.status !== "done") return json({ status: j.status });
    return json({ status: "done", result: j.demo === false ? r.safe(j.result) : r.demo(j.result) });
  }

  async function trace(req: Request) {
    if (!opts.traces) return json({ ok: true, kept: false });
    const a = (await req.json().catch(() => ({}))) as { session?: string; events?: ClientEvent[] };
    const session = String(a.session ?? "");
    if (!SESSION.test(session)) return json({ error: "bad session" }, 400);
    await writeTrace(session, a.events ?? []);
    return json({ ok: true });
  }

  async function writeTrace(session: string, events: ClientEvent[]) {
    // Secrets and emails are stripped; amounts are kept, as in hev dot.
    if (opts.traces) await opts.traces(session, r.safe(toLines(session, events)));
  }

  const dot: Dot = {
    registry: tools,
    invoke,
    persona: personaFor,
    trace: writeTrace,
    async fetch(req, _env, exec) {
      for (const pk of packs) {
        const out = await pk.routes?.(req);
        if (out) return out;
      }
      const p = new URL(req.url).pathname;
      if (!p.startsWith(base + "/")) return json({ error: "no" }, 404);
      const route = p.slice(base.length);
      if (req.method === "GET" && route === "/token") return token(req);
      if (req.method === "POST" && route === "/tool") return tool(req, exec);
      if (req.method === "POST" && route === "/trace") return trace(req);
      if (req.method === "POST" && route === "/chat") return talk(req, exec);
      if (req.method === "GET" && route === "/info") return info();
      const m = route.match(/^\/job\/([0-9a-f]{8})$/);
      if (req.method === "GET" && m) return job(m[1]);
      return json({ error: "no" }, 404);
    },
  };
  const text = opts.chat ? chat({ dot, model: opts.chat, store, surface: "text" }) : null;
  return dot;
}
