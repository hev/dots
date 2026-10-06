import { gate } from "./receipts.ts";
import { redactor, type RedactOptions } from "./redact.ts";
import { memoryStore } from "./stores.ts";
import { registry, type Registry } from "./tools.ts";
import { SESSION, toLines, type ClientEvent } from "./traces.ts";
import type { Ctx, Identity, Store, ToolServer, TraceSink, VoiceProvider } from "./types.ts";

export type PersonaInput = {
  demo: boolean;
  /** One line per tool, built from the declarations. */
  capabilities: string;
  /** "Real is Codename; ..." for demo mode. */
  codebook: string;
  /** Where the dot is talking: "voice" on the site, or a text surface like "slack". */
  surface: string;
};

export type DotOptions = {
  name: string;
  persona: (p: PersonaInput) => string | Promise<string>;
  voice: VoiceProvider;
  tools: ToolServer[];
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
  const tools = await registry(opts.tools);
  const r = redactor(opts.redact);
  const store = opts.store ?? memoryStore();
  const logins = new Set(opts.logins ?? []);
  const base = opts.base ?? "/api";
  const log = opts.log ?? (() => {});

  const who = async (req: Request) => (opts.identity ? await opts.identity(req) : null);
  const allowed = (w: string | null) => w !== null && logins.has(w);

  const personaFor = async (demo: boolean, surface: string) =>
    opts.persona({ demo, capabilities: tools.capabilities(), codebook: r.codebook(), surface });

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

  return {
    registry: tools,
    invoke,
    persona: personaFor,
    trace: writeTrace,
    async fetch(req, _env, exec) {
      const p = new URL(req.url).pathname;
      if (!p.startsWith(base + "/")) return json({ error: "no" }, 404);
      const route = p.slice(base.length);
      if (req.method === "GET" && route === "/token") return token(req);
      if (req.method === "POST" && route === "/tool") return tool(req, exec);
      if (req.method === "POST" && route === "/trace") return trace(req);
      const m = route.match(/^\/job\/([0-9a-f]{8})$/);
      if (req.method === "GET" && m) return job(m[1]);
      return json({ error: "no" }, 404);
    },
  };
}
