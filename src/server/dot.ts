import { chat, type ChatModel, type Image } from "./chat.ts";
import { applyPatch, effective, type ConfigDefaults } from "./config.ts";
import { callArgs, hold, held, spend, voiceYes, type ApprovalOptions, type Held } from "./receipts.ts";
import { redactor, type RedactOptions } from "./redact.ts";
import { memoryStore, storeConfig } from "./stores.ts";
import { think, thinkDecl, type SubagentOptions } from "./think.ts";
import { capabilityLines, CONFIRM, CONFIRM_DECL, defineTool, local, registry, type Registry } from "./tools.ts";
import { SESSION, SESSION_START, toLines, type ClientEvent } from "./traces.ts";
import type { ConfigStore, Ctx, DotConfig, DotIdentity, Identity, Pack, Store, ToolDecl, ToolServer, TraceSink, Version, VoiceProvider } from "./types.ts";

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
  /** The system prompt from the user's settings (the dot's default until they edit it). Appended to the persona unless the persona already includes it. */
  prompt: string;
  /** The name, icon, theme, voice and model from the user's settings. */
  identity: DotIdentity;
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
  /** Pending approvals, slow-job results and threads. Defaults to memory (one process). */
  store?: Store;
  /** The user's settings (identity, prompt, tools, sources). Defaults to the store, under "config". */
  config?: ConfigStore;
  /** What the user's settings start from, and reset to. */
  defaults?: ConfigDefaults;
  /** Voices the configurator offers (e.g. Gemini's prebuilt names). Without it, any plain name is accepted. */
  voices?: string[];
  /** Held calls: how long they wait, the gap a spoken yes needs without a turn, and whether a spoken yes counts. See receipts.ts. */
  approvals?: ApprovalOptions;
  /** @deprecated The read-back receipts are gone; `gapMs` still sets approvals.gapMs and `refusals` is ignored. */
  receipts?: { gapMs?: number; refusals?: number };
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
  /** One tool call through the whole policy: settings, kinds, logins, approvals, redaction. Every surface goes through this. */
  invoke(name: string, args: Record<string, unknown>, ctx: Ctx, exec?: Exec): Promise<{ status: number; body: unknown }>;
  /** The tools the model is offered now: the enabled ones, plus confirm_action when any of them asks first. */
  decls(): Promise<ToolDecl[]>;
  /** The user's settings now, every field filled. Read-only here: only PUT /api/config, as an allowed login, changes them. */
  config(): Promise<DotConfig>;
  /** What happened off the model's view since its last turn (an approval card answered), for a text surface to pass on. Read once. */
  notes(session: string): Promise<string[]>;
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

const isJson = (req: Request) => /^application\/json\b/i.test(req.headers.get("content-type") ?? "");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function defineDot(opts: DotOptions): Promise<Dot> {
  const packs = opts.packs ?? [];
  const sub = opts.subagent;
  const subTools = sub
    ? [local([defineTool({ ...thinkDecl(sub), run: async (a, ctx) => think(sub, String(a.question ?? ""), ctx, { tools, decls: await dot.decls(), invoke, persona: await personaFor(ctx.demo, "subagent") }) })])]
    : [];
  const tools = await registry([...opts.tools, ...packs.map((p) => p.tools), ...subTools]);
  const settings = opts.config ?? storeConfig(opts.store ?? memoryStore());
  const defaults = opts.defaults ?? {};
  const approvals: ApprovalOptions = { ...(opts.receipts?.gapMs !== undefined ? { gapMs: opts.receipts.gapMs } : {}), ...opts.approvals };
  const guidance = packs.filter((p) => p.guidance).map((p) => `${p.name}:\n${p.guidance}`).join("\n\n");
  const r = redactor(opts.redact);
  const store = opts.store ?? memoryStore();
  const logins = new Set(opts.logins ?? []);
  const base = opts.base ?? "/api";
  const log = opts.log ?? (() => {});

  const who = async (req: Request) => (opts.identity ? await opts.identity(req) : null);
  const allowed = (w: string | null) => w !== null && logins.has(w);

  const config = async () => effective(opts.name, tools.decls, defaults, await settings.load());

  /** What the model is offered under these settings. confirm_action comes with any tool that asks, unless spoken yeses are off. */
  function offered(cfg: DotConfig): ToolDecl[] {
    const on = tools.decls.filter((d) => cfg.tools[d.name]?.enabled);
    const asks = on.some((d) => cfg.tools[d.name].approval === "ask");
    return asks && approvals.voice !== false ? [...on, CONFIRM_DECL] : on;
  }

  const personaFor = async (demo: boolean, surface: string) => {
    const cfg = await config();
    const capabilities = capabilityLines(offered(cfg), (n) => cfg.tools[n]?.approval ?? "always");
    const prompt = cfg.systemPrompt;
    const base = await opts.persona({ demo, capabilities, codebook: r.codebook(), surface, guidance, prompt, identity: cfg.identity });
    return prompt.trim() && !base.includes(prompt.trim()) ? `${base}\n\n${prompt.trim()}` : base;
  };

  async function token(req: Request) {
    const demo = new URL(req.url).searchParams.get("safe") !== "0";
    if (!demo && !allowed(await who(req))) return json({ error: "private mode needs an allowed login" }, 403);
    const persona = await personaFor(demo, "voice");
    const cfg = await config();
    // Returned raw: the redactor would mask the token.
    return json(await opts.voice.mint({ persona, tools: offered(cfg), ...(cfg.identity.voice ? { voice: cfg.identity.voice } : {}) }));
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
    if (name === CONFIRM) return confirm(args, ctx, exec);
    const kind = tools.kind(name);
    const cfg = await config();
    const set = cfg.tools[name];
    if (!set) return json({ error: `unknown tool ${name}` }, 404);
    if (!set.enabled) return json({ error: `${name} is turned off in the user's settings. Don't retry.` }, 403);

    if (kind === "private" && ctx.demo) return json({ error: "that's private-mode only; switch demo mode off" });
    if ((kind === "act" || kind === "display" || set.approval === "ask" || !ctx.demo) && !allowed(ctx.who)) {
      return json({ error: `not allowed for ${ctx.who ?? "anonymous"}` }, 403);
    }
    if (set.approval === "deny") {
      log(`DENY ${ctx.who ?? "-"} ${name}`);
      return json({ error: `${name} is refused by the user's settings. Tell them plainly; don't retry.`, denied: true }, 403);
    }
    if (set.approval === "ask") {
      if (!SESSION.test(ctx.session)) return json({ error: "a call that needs a yes needs a session" }, 400);
      const p = await hold(store, ctx, name, callArgs(args), approvals);
      log(`ASK ${ctx.who ?? "-"} ${name} ${p.id.slice(0, 8)}`);
      return json(
        r.safe({
          pending_approval: p,
          say:
            "Not run yet: it's waiting for the user's yes on the approval card. Tell them in a sentence what's waiting and stop; don't call it again." +
            (approvals.voice !== false ? ` If they then clearly say yes out loud, call ${CONFIRM} with this id.` : ""),
        }),
      );
    }
    return run(name, kind === "act" ? callArgs(args) : args, ctx, exec);
  }

  /** Runs a call that has passed the policy: acts dry-run unless live, slow tools get a job, results are redacted for the mode. */
  async function run(name: string, args: Record<string, unknown>, ctx: Ctx, exec?: Exec) {
    const json = (body: unknown, status = 200) => ({ status, body });
    const kind = tools.kind(name);
    const t0 = Date.now();
    if (kind === "act") {
      log(`ACT ${ctx.who ?? "-"} ${name} run`);
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

  // Answering a held call. Each one is answered once: it leaves the store before it runs, and
  // `answering` stops a second answer racing the first within this process.
  const answering = new Set<string>();

  /** A spoken yes, relayed by the model: approve once, never "always", only after the user has had their turn. */
  async function confirm(args: Record<string, unknown>, ctx: Ctx, exec?: Exec) {
    if (!allowed(ctx.who)) return { status: 403, body: { error: `not allowed for ${ctx.who ?? "anonymous"}` } };
    const h = await held(store, String(args.id ?? ""));
    const why = h ? voiceYes(h, ctx, approvals) : "no such approval waiting: it was answered, cancelled or it expired";
    if (why !== true) return { status: 409, body: { error: why } };
    return decide(h!, "approve", ctx.who, exec);
  }

  async function decide(h: Held, decision: "approve" | "always" | "deny", w: string | null, exec?: Exec) {
    if (answering.has(h.id)) return { status: 409, body: { error: "already being answered" } };
    answering.add(h.id);
    try {
      await spend(store, h);
      const ctx: Ctx = { session: h.session, who: w, demo: h.demo };
      log(`APPROVAL ${w ?? "-"} ${h.tool} ${h.id.slice(0, 8)} ${decision}`);
      if (decision === "deny") {
        await note(h.session, `The user cancelled ${h.summary}. It did not run.`);
        return { status: 200, body: { id: h.id, tool: h.tool, decision, cancelled: true } };
      }
      // The setting now, not when the call was held: a tool turned off or denied since can't be approved through.
      const set = (await config()).tools[h.tool];
      if (!set?.enabled || set.approval === "deny") {
        await note(h.session, `${h.summary} was refused by the user's settings. It did not run.`);
        return { status: 403, body: { id: h.id, tool: h.tool, decision, error: `${h.tool} is refused by the user's settings` } };
      }
      if (decision === "always") {
        const stored = (await settings.load()) ?? {};
        await settings.save({ ...stored, tools: { ...stored.tools, [h.tool]: { ...stored.tools?.[h.tool], approval: "always" } } });
      }
      const { status, body } = await run(h.tool, h.args, ctx, exec);
      await note(h.session, `The user approved ${h.summary}${decision === "always" ? " (and from now on it runs without asking)" : ""}. Result: ${JSON.stringify(body).slice(0, 1500)}`);
      return { status, body: { id: h.id, tool: h.tool, decision, result: body } };
    } finally {
      answering.delete(h.id);
    }
  }

  const notesKey = (session: string) => `notes:${session}`;
  async function note(session: string, text: string) {
    const was = ((await store.get(notesKey(session))) as string[] | undefined) ?? [];
    await store.put(notesKey(session), [...was, text].slice(-10), 3600);
  }
  async function notes(session: string) {
    const n = ((await store.get(notesKey(session))) as string[] | undefined) ?? [];
    if (n.length) await store.delete(notesKey(session));
    return n;
  }

  /** The approval card's buttons: only the signed-in user the call was held for, as JSON (so a form on another site can't post it). */
  async function approve(req: Request, id: string, exec?: Exec) {
    if (!isJson(req)) return json({ error: "send JSON" }, 415);
    const w = await who(req);
    if (!allowed(w)) return json({ error: `not allowed for ${w ?? "anonymous"}` }, 403);
    const a = (await req.json().catch(() => ({}))) as { decision?: string };
    if (a.decision !== "approve" && a.decision !== "always" && a.decision !== "deny") return json({ error: "decision is approve, always or deny" }, 400);
    const h = await held(store, id);
    if (!h || h.who !== w) return json({ error: "no such approval waiting: it was answered, cancelled or it expired" }, 404);
    const { status, body } = await decide(h, a.decision, w, exec);
    return json(body, status);
  }

  /** The configurator's view: the settings, and what they can be set to. */
  async function configView() {
    const cfg = await config();
    return {
      config: cfg,
      defaults: effective(opts.name, tools.decls, defaults),
      tools: tools.decls.map((d) => ({ name: d.name, kind: d.kind ?? "read", description: d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "") })),
      models: Object.entries(opts.chatModels ?? {}).map(([id, model]) => ({ id, name: model.name })),
      voices: opts.voices ?? null,
    };
  }

  async function configure(req: Request) {
    const w = await who(req);
    if (!allowed(w)) return json({ error: "settings need an allowed login" }, 403);
    if (req.method === "GET") return json(await configView());
    if (!isJson(req)) return json({ error: "send JSON" }, 415);
    const body = await req.json().catch(() => undefined);
    const next = applyPatch((await settings.load()) ?? {}, body, {
      tools: new Set(tools.decls.map((d) => d.name)),
      models: new Set(Object.keys(opts.chatModels ?? {})),
      voices: opts.voices,
      defaultPrompt: defaults.systemPrompt ?? "",
    });
    if (typeof next === "string") return json({ error: next }, 400);
    await settings.save(next);
    log(`CONFIG ${w} ${Object.keys(body as object).join(",")}`);
    return json(await configView());
  }

  /** A typed turn: the same persona, tools and policy, answered in text. Streams NDJSON: {slow}, {display}, then {reply} or {error}. */
  async function talk(req: Request, exec?: Exec) {
    if (!text && !Object.keys(textModels).length) return json({ error: "this dot has no text model" }, 404);
    const a = (await req.json().catch(() => ({}))) as { text?: string; session?: string; safe?: boolean; images?: unknown; model?: string };
    const picked = (await config()).identity.model;
    const selected = a.model === undefined || a.model === "" ? (picked && Object.hasOwn(textModels, picked) ? textModels[picked] : text) : (Object.hasOwn(textModels, a.model) ? textModels[a.model] : undefined);
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
      .turn(ctx, said, { onSlow: (name) => send({ slow: name }), onDisplay: (name, result) => send({ display: result, name }), onApproval: (name, approval) => send({ approval, name }) }, images)
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

  /** What the screen's info pane shows: the tools, in the persona's own words, and the inbox; and the identity the screen draws. */
  async function info() {
    const cfg = await config();
    const picked = cfg.identity.model && opts.chatModels?.[cfg.identity.model];
    const { name, icon, theme } = cfg.identity;
    return json({
      name: opts.name,
      identity: { name, icon, theme },
      inbox: opts.inbox ?? null,
      text: !!text,
      defaultModel: (picked || defaultModel)?.name ?? null,
      models: Object.entries(opts.chatModels ?? {}).map(([id, model]) => ({ id, name: model.name })),
      version: opts.version ?? null,
      tools: tools.decls.filter((d) => cfg.tools[d.name]?.enabled).map((d) => ({ name: d.name, kind: d.kind ?? "read", description: d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "") })),
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
    decls: async () => offered(await config()),
    config,
    notes,
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
      if ((req.method === "GET" || req.method === "PUT") && route === "/config") return configure(req);
      const ap = route.match(/^\/approvals\/([0-9a-f-]{36})$/);
      if (req.method === "POST" && ap) return approve(req, ap[1], exec);
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
