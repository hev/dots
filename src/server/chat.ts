// A text turn loop over the same dot: same persona, same tools, same policy.
// Text surfaces (Slack, later others) use this; the voice surface talks to the
// speech provider directly. Every tool call goes through dot.invoke(), so an
// act still needs a read-back and a matching yes, checked on the server.

import type { Dot } from "./dot.ts";
import type { ClientEvent } from "./traces.ts";
import type { Ctx, Store, ToolDecl } from "./types.ts";

/** A photo attached to a typed turn: base64 data, no data: prefix. */
export type Image = { mimeType: string; data: string };

export type Call = { id: string; name: string; args: Record<string, unknown> };

export type Msg =
  | { role: "user"; text: string; images?: Image[] }
  /** `raw` is the provider's own turn, sent back as-is (Gemini 3 needs its thought signatures returned). */
  | { role: "model"; text?: string; calls?: Call[]; raw?: unknown }
  | { role: "tool"; results: { id: string; name: string; result: unknown }[] };

/** A text model with function calling. */
export type ChatModel = {
  name: string;
  turn(req: { system: string; history: Msg[]; tools: ToolDecl[] }): Promise<{ text?: string; calls?: Call[]; raw?: unknown }>;
};

export type ChatOptions = {
  dot: Dot;
  model: ChatModel;
  store: Store;
  surface: string;
  /** Tool rounds per turn before giving up. */
  maxSteps?: number;
  /** History kept per session, in messages. */
  keep?: number;
};

export type TurnHooks = {
  /** A display tool's result (a link, a card), for the surface to show. */
  onDisplay?(name: string, result: unknown): void | Promise<void>;
  /** A slow tool started; the surface can say it's working. */
  onSlow?(name: string): void | Promise<void>;
};

const POLL_MS = 1500;
const SLOW_LIMIT_MS = 30 * 60_000;

export function chat(o: ChatOptions) {
  const maxSteps = o.maxSteps ?? 8;
  const keep = o.keep ?? 40;

  /** Run a slow tool to the end: the chat loop has no app to poll for it. */
  async function finish(job: string): Promise<unknown> {
    const t0 = Date.now();
    while (Date.now() - t0 < SLOW_LIMIT_MS) {
      const res = await o.dot.fetch(new Request(`http://dot/api/job/${job}`));
      const j = (await res.json()) as { status: string; result?: unknown };
      if (j.status === "done") return j.result;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return { error: "the sub-agent didn't finish in 30 minutes" };
  }

  const keyOf = (ctx: Ctx) => `chat:${o.surface}:${ctx.session}`;

  return {
    /** One user message in, the dot's reply out. */
    async turn(ctx: Ctx, text: string, hooks: TurnHooks = {}, images: Image[] = []): Promise<string> {
      const key = keyOf(ctx);
      const history = (((await o.store.get(key)) as Msg[] | undefined) ?? []).slice(-keep);
      const trace: ClientEvent[] = [{ kind: "u", id: `${Date.now()}u`, ts: Date.now(), text: images.length ? `[${images.length} photo${images.length > 1 ? "s" : ""}] ${text}` : text }];
      history.push({ role: "user", text, ...(images.length ? { images } : {}) });
      const system = await o.dot.persona(ctx.demo, o.surface);

      let reply = "";
      for (let step = 0; step < maxSteps; step++) {
        const out = await o.model.turn({ system, history, tools: o.dot.registry.decls });
        history.push({ role: "model", text: out.text, calls: out.calls, raw: out.raw });
        if (!out.calls?.length) {
          reply = out.text ?? "";
          break;
        }
        const results = [];
        for (const c of out.calls) {
          const t0 = Date.now();
          const kind = o.dot.registry.kind(c.name);
          let { body } = await o.dot.invoke(c.name, c.args, ctx);
          if (kind === "slow" && body && typeof body === "object" && "job" in body) {
            await hooks.onSlow?.(c.name);
            body = await finish(String((body as { job: string }).job));
          }
          if (kind === "display" && !(body && typeof body === "object" && "error" in body)) {
            await hooks.onDisplay?.(c.name, body);
            body = { shown: true };
          }
          results.push({ id: c.id, name: c.name, result: body });
          trace.push({ kind: "tool", id: c.id, ts: Date.now(), name: c.name, args: c.args, result: body, ms: Date.now() - t0 });
        }
        history.push({ role: "tool", results });
      }
      if (!reply) reply = "I went round in circles on that one. Ask me again, more narrowly?";

      trace.push({ kind: "d", id: `${Date.now()}d`, ts: Date.now(), text: reply, model: o.model.name });
      // Photos stay with the last two messages that had them; older ones keep a mark, so the history stays small.
      let seen = 0;
      const kept = history.slice(-keep).reverse().map((m) => (m.role === "user" && m.images ? (++seen > 2 ? { role: "user" as const, text: `[a photo she shared earlier] ${m.text}` } : m) : m)).reverse();
      await o.store.put(key, kept, 7 * 24 * 3600);
      await o.dot.trace(ctx.session, trace);
      return reply;
    },

    /** Forget the session's history, so the next turn starts fresh. The trace keeps a mark where it ended. */
    async clear(ctx: Ctx): Promise<void> {
      await o.store.delete(keyOf(ctx));
      await o.dot.trace(ctx.session, [{ kind: "t", id: `${Date.now()}c`, ts: Date.now(), text: "cleared" }]);
    },
  };
}
