import { chat, type ChatModel, type Image } from "./chat.ts";
import { gate, type GateOptions } from "./receipts.ts";
import { redactor, type RedactOptions } from "./redact.ts";
import { memoryStore } from "./stores.ts";
import { think, thinkDecl, type SubagentOptions } from "./think.ts";
import { defineTool, local, registry, type Registry } from "./tools.ts";
import { SESSION, SESSION_START, toLines, type ClientEvent } from "./traces.ts";
import type { Ctx, Identity, Pack, Store, ToolServer, TraceSink, Version, VoiceProvider } from "./types.ts";

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
  /** A text model for typed turns on the screen (`POST /chat`). Without it, typed turns report that text is unavailable. */
  chat?: ChatModel;
  /** Server allowlist for the screen picker. Keys are public IDs, values are configured adapters. */
  chatModels?: Record<string, ChatModel>;
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
  /** Act receipts: the gap a yes needs without a turn (`gapMs`, default 4000) and refused confirmed calls before a tool stops (`refusals`, default 2). See receipts.ts. */
  receipts?: Pick<GateOptions, "gapMs" | "refusals">;
  /** When false, confirmed acts answer with what they would have done. Default false. */
  live?: boolean;
  /** Mount point for the routes. Default "/api". */
  base?: string;
  /** The running build (see gitVersion in /version). Reported by GET /api/info and stamped on each session's start in traces. */
  version?: Version;
  log?: (line: string) => void;
};

type Exec = { waitUntil(p: Promise<unknown>): void };

export type Dot = {
  fetch(req: Request, env?: unknown, exec?: Exec): Promise<Response>;
  registry: Registry;
  /** One tool call through the whole policy: kinds, logins, receipts, redaction. Every surface goes through this. */
  invoke(name: string, args: Record<string, unknown>, ctx: Ctx, exec?: Exec): Promise<{ status: number; body: unknown }>;
  persona(demo: boolean, surface: string): Promise<string>;
  /** Writes trace lines through the configured sink, secrets stripped. With `who`, the turns are also kept as that user's thread (see threads below). */
  trace(session: string, events: ClientEvent[], who?: string | null): Promise<void>;
};

/** A thread in the screen's drawer: the session id, its first line and when it was last used (ms). */
export type ThreadSummary = { id: string; first: string; at: number };
/** One kept line of a thread: what the user said (with photo thumbnails) or the dot answered, or a card or link that went up. */
export type ThreadLine = { k: "u" | "d" | "t"; text: string; ts: number; photos?: string[] };

const THREAD_TTL = 30 * 24 * 3600;
const THREADS_KEPT = 50;
const LINES_KEPT = 300;
const THUMB = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const thumbOk = (t: unknown): t is string => typeof t === "string" && t.length <= 80_000 && THUMB.test(t);

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
      const g = await gate(store, ctx.session, name, args, { ...opts.receipts, turn: ctx.turn });
      log(`ACT ${ctx.who ?? "-"} ${name} ${g.run ? "run" : "error" in g ? (g.stop ? "stopped" : "refused") : "readback"}`);
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
    if (!text && !Object.keys(textModels).length) return json({ error: "this dot has no text model" }, 404);
    const a = (await req.json().catch(() => ({}))) as { text?: string; session?: string; safe?: boolean; images?: unknown; model?: string };
    const selected = a.model === undefined ? text : (Object.hasOwn(textModels, a.model) ? textModels[a.model] : undefined);
    if (!selected) return json({ error: "text model is unavailable" }, 400);
    const session = String(a.session ?? "");
    if (!SESSION.test(session)) return json({ error: "bad session" }, 400);
    const images = photos(a.images);
    if (typeof images === "string") return json({ error: images }, 400);
    const said = String(a.text ?? "").trim().slice(0, 4000) || (images.length ? "What do you make of this?" : "");
    if (!said) return json({ error: "say something" }, 400);
    const ctx: Ctx = { session, who: await who(req), demo: a.safe !== false };
    if (!ctx.demo && !allowed(ctx.who)) return json({ error: "private mode needs an allowed login" }, 403);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const send = (o: unknown) => w.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));
    const done = selected
      .turn(ctx, said, { onSlow: (name) => send({ slow: name }), onDisplay: (name, result) => send({ display: result, name }) }, images)
      .then((reply) => send({ reply }), (e) => send({ error: String(e).slice(0, 300) }))
      .finally(() => w.close());
    exec?.waitUntil(done);
    return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
  }

  /** Photos from the screen: up to four, JPEG, PNG or WebP, base64, each under about 5 MB. A string is what's wrong. */
  function photos(x: unknown): Image[] | string {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x) || x.length > 4) return "up to four photos";
    for (const i of x as Image[])
      if (!i || !/^image\/(jpeg|png|webp)$/.test(String(i.mimeType)) || typeof i.data !== "string" || i.data.length > 7_000_000 || !/^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 200)))
        return "a photo has to be a JPEG, PNG or WebP under 5 MB";
    return (x as Image[]).map((i) => ({ mimeType: i.mimeType, data: i.data, ...(thumbOk(i.thumb) ? { thumb: i.thumb } : {}) }));
  }

  /** What the screen's info pane shows: the tools, in the persona's own words, and the inbox. */
  function info() {
    return json({
      name: opts.name,
      inbox: opts.inbox ?? null,
      text: !!text,
      defaultModel: defaultModel?.name ?? null,
      models: Object.entries(opts.chatModels ?? {}).map(([id, model]) => ({ id, name: model.name })),
      version: opts.version ?? null,
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
    await writeTrace(session, Array.isArray(a.events) ? a.events : [], await who(req));
    return json({ ok: true });
  }

  // Threads: the screen's sessions, kept per user in the store so the drawer can
  // list them and a tap resumes one. Only the turns are kept (what was said, the
  // photos' thumbnails, cards and links), secrets stripped as in traces. A thread
  // belongs to whoever wrote it first; nobody else can read or add to it.
  const threadKey = (session: string) => `thread:${session}`;
  const indexKey = (w: string) => `threads:${w}`;

  async function keepThread(session: string, events: ClientEvent[], w: string) {
    const lines: ThreadLine[] = [];
    for (const e of events.slice(0, 200)) {
      const ts = typeof e.ts === "number" ? e.ts : Date.parse(String(e.ts ?? "")) || Date.now();
      const text = r.safe(String(e.text ?? "").slice(0, 4000));
      if (e.kind === "u" || e.kind === "d") {
        const photos = (Array.isArray(e.photos) ? e.photos : []).filter(thumbOk).slice(0, 4);
        if (text || photos.length) lines.push({ k: e.kind, text, ts, ...(photos.length ? { photos } : {}) });
      } else if (e.kind === "t" && text && (e.card || e.url)) lines.push({ k: "t", text, ts });
    }
    if (!lines.length) return;
    const t = (await store.get(threadKey(session))) as { who: string; lines: ThreadLine[] } | undefined;
    if (t && t.who !== w) return;
    await store.put(threadKey(session), { who: w, lines: [...(t?.lines ?? []), ...lines].slice(-LINES_KEPT) }, THREAD_TTL);
    const index = ((await store.get(indexKey(w))) as ThreadSummary[] | undefined) ?? [];
    const was = index.find((x) => x.id === session);
    const said = lines.find((l) => l.k === "u");
    const first = was?.first || (said ? said.text.split("\n")[0].slice(0, 120) || "📷 photo" : "");
    const next = [{ id: session, first, at: Date.now() }, ...index.filter((x) => x.id !== session)].slice(0, THREADS_KEPT);
    await store.put(indexKey(w), next, THREAD_TTL);
  }

  /** Read back in the mode the screen is in (`?safe=0` for private, as for the token): demo masks amounts, so a private thread can't show its numbers in a demo. */
  async function threads(req: Request, id?: string) {
    const w = await who(req);
    if (w === null) return json({ error: "threads need a login" }, 403);
    const demo = new URL(req.url).searchParams.get("safe") !== "0";
    if (!demo && !allowed(w)) return json({ error: "private mode needs an allowed login" }, 403);
    const say = (s: string) => (demo ? r.demo(s) : s);
    if (!id) {
      const index = ((await store.get(indexKey(w))) as ThreadSummary[] | undefined) ?? [];
      return json({ threads: index.filter((x) => x.first).sort((a, b) => b.at - a.at).map((x) => ({ ...x, first: say(x.first) })) });
    }
    const t = (await store.get(threadKey(id))) as { who: string; lines: ThreadLine[] } | undefined;
    if (!t || t.who !== w) return json({ error: "no such thread" }, 404);
    return json({ id, lines: t.lines.map((l) => ({ ...l, text: say(l.text) })) });
  }

  async function writeTrace(session: string, events: ClientEvent[], w?: string | null) {
    if (w) await keepThread(session, events, w);
    // Secrets and emails are stripped; amounts are kept, as in hev dot.
    // The build is added after redaction, which would take a full commit for a key.
    const v = opts.version;
    if (opts.traces) await opts.traces(session, r.safe(toLines(session, events)).map((l) => (v && l.role === "event" && l.text === SESSION_START ? { ...l, version: v } : l)));
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
      if (req.method === "GET" && route === "/threads") return threads(req);
      const t = route.match(/^\/threads\/([0-9a-f-]{8,40})$/);
      if (req.method === "GET" && t) return threads(req, t[1]);
      const m = route.match(/^\/job\/([0-9a-f]{8})$/);
      if (req.method === "GET" && m) return job(m[1]);
      return json({ error: "no" }, 404);
    },
  };
  const defaultModel = opts.chat ?? Object.values(opts.chatModels ?? {})[0];
  const text = defaultModel ? chat({ dot, model: defaultModel, store, surface: "text", threads: true }) : null;
  const textModels = Object.fromEntries(Object.entries(opts.chatModels ?? {}).map(([id, model]) => [id, chat({ dot, model, store, surface: "text", threads: true })]));
  return dot;
}
