// Pending approvals: the server, not the model or the browser, decides whether a
// tool call runs. Each tool has a setting the user keeps in the configurator
// (see config.ts): "always" runs, "deny" refuses, and "ask" (the default for acts)
// holds the call here, with exactly the arguments the model sent, and answers
// `pending_approval`. The screen draws it as a card with Approve, Always approve
// and Cancel, which post to /api/approvals/:id as the signed-in user. Approving
// runs the held arguments once; the model can't change them after the fact.
//
// Hands-free, the user can say yes instead: the model relays it by calling
// confirm_action with the approval's id. That path only ever approves once (never
// "always"), only for the same session and login, and only after the user has had
// a turn to answer: on a surface that knows its turns (the chat loop) the yes has to
// come in a later turn than the call; on the voice screen, at least `gapMs` later.
// No verbatim read-back is needed: the card shows the arguments, and the yes is for
// that id.
//
// This replaces the read-back receipts (the model reading the arguments back word
// for word, then calling again with confirmed=true), which models looped on.

import type { PendingApproval, Store } from "./types.ts";

export type ApprovalOptions = {
  /** How long a held call waits for a yes. Default 10 minutes. */
  ttlSeconds?: number;
  /** Without a turn (the voice screen): the least time between holding a call and a spoken yes for it. Default 4000 ms. */
  gapMs?: number;
  /** Let a spoken yes approve through confirm_action. Default true; false leaves only the card. */
  voice?: boolean;
};

/** A held call as the store keeps it: the card's fields plus who and where it belongs to. */
export type Held = PendingApproval & { session: string; who: string | null; demo: boolean; turn?: string; at: number };

const TTL = 10 * 60;

/** Stable JSON: keys sorted, so {a,b} and {b,a} are the same call. */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

async function hash(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const idKey = (id: string) => `approval:${id}`;
const callKey = (session: string, who: string | null, tool: string, args: Record<string, unknown>) =>
  hash(`${session}\n${who ?? ""}\n${tool}\n${canonical(args)}`).then((h) => "approval-call:" + h);

/** The call in a line, for the card and the model: the action, then each argument, values cut short. */
export function summarize(tool: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map((k) => {
      const v = typeof args[k] === "string" ? (args[k] as string) : canonical(args[k]);
      return `${k.replace(/_/g, " ")}: ${v.length > 120 ? v.slice(0, 119) + "…" : v}`;
    });
  const s = `${tool.replace(/_/g, " ")}${parts.length ? " · " + parts.join("; ") : ""}`;
  return s.length > 400 ? s.slice(0, 399) + "…" : s;
}

/** @deprecated The read-back is gone; this is the approval summary under its old name. */
export const readbackText = summarize;

/** The arguments a call is held with: a `confirmed` flag from the old read-back flow isn't part of the call. */
export function callArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { confirmed: _c, ...rest } = args;
  return rest;
}

/**
 * Holds a call for the user's yes and answers what the card shows. The same call again in
 * the same session, by the same login (a model retrying), gets the approval already waiting, not a second card.
 */
export async function hold(
  store: Store,
  where: { session: string; who: string | null; demo: boolean; turn?: string },
  tool: string,
  args: Record<string, unknown>,
  o: ApprovalOptions = {},
): Promise<PendingApproval> {
  const ck = await callKey(where.session, where.who, tool, args);
  const was = (await store.get(ck)) as string | undefined;
  const old = was ? ((await store.get(idKey(was))) as Held | undefined) : undefined;
  if (old && old.expires > Date.now()) return card(old);
  const ttl = o.ttlSeconds ?? TTL;
  const at = Date.now();
  const held: Held = {
    id: crypto.randomUUID(),
    tool,
    args,
    summary: summarize(tool, args),
    expires: at + ttl * 1000,
    session: where.session,
    who: where.who,
    demo: where.demo,
    at,
    ...(where.turn !== undefined ? { turn: where.turn } : {}),
  };
  await store.put(idKey(held.id), held, ttl);
  await store.put(ck, held.id, ttl);
  return card(held);
}

/** The part of a held call the screen and the model see. */
export function card(h: Held): PendingApproval {
  return { id: h.id, tool: h.tool, args: h.args, summary: h.summary, expires: h.expires };
}

/** A held call by id, if it's still waiting. */
export async function held(store: Store, id: string): Promise<Held | undefined> {
  const h = (await store.get(idKey(id))) as Held | undefined;
  return h && h.expires > Date.now() ? h : undefined;
}

/** Spends a held call: gone from the store, so it can't be approved twice. */
export async function spend(store: Store, h: Held): Promise<void> {
  await store.delete(idKey(h.id));
  await store.delete(await callKey(h.session, h.who, h.tool, h.args));
}

/**
 * Whether a spoken yes, relayed by the model, may approve a held call: same session and login,
 * and the user has had their turn to answer since the call was held. A string says why not.
 */
export function voiceYes(h: Held, ctx: { session: string; who: string | null; turn?: string }, o: ApprovalOptions = {}): true | string {
  if (o.voice === false) return "spoken approval is off for this dot; the user approves on the card";
  if (h.session !== ctx.session || h.who !== ctx.who) return "no such approval waiting";
  const early = ctx.turn !== undefined && h.turn !== undefined ? ctx.turn === h.turn : Date.now() - h.at < (o.gapMs ?? 4000);
  if (early) return "not yet: the user hasn't answered. Tell them what's waiting and wait for a clear yes";
  return true;
}
