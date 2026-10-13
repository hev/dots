// Act receipts: the server, not the model or the browser, decides whether an
// action runs. An act called without `confirmed` stores a receipt for exactly
// those arguments and returns a read-back. `confirmed: true` runs only if a
// receipt for the same session, tool and arguments is waiting; a changed
// draft needs a new yes. Idea from OpenDots' review receipts, enforced here.
//
// Models (Gemini Live especially) skip the first call, or read back in their own
// words and retry with reworded arguments, forever. So a confirmed call with no
// receipt doesn't just fail: it stores a receipt for those exact arguments and
// returns the read-back, and the next yes matches. The yes has to come after the
// read-back, not in the same breath:
// - On a surface that knows its turns (the chat loop passes `ctx.turn`), the
//   receipt must be from an earlier user turn.
// - Otherwise (the voice screen: Live gives the server no reliable turn edge,
//   its transcriptions can land after the tool call) at least `gapMs` must pass
//   between issuing the receipt and accepting it. Default 4s: shorter than a
//   spoken read-back plus a spoken yes, longer than a model calling straight back.
// And once `refusals` confirmed calls of one tool in one session have been
// refused (a run clears the count), the next refused one stops the tool for that session: the model is told to stop, say plainly it didn't
// go through, and not retry. A new session starts clean.

import type { Store } from "./types.ts";

const TTL = 10 * 60;
const STOP_TTL = 30 * 60;

export type GateOptions = {
  /** The user turn this call belongs to, when the surface knows it. A receipt is accepted only from an earlier turn. */
  turn?: string;
  /** Without a turn: the least time between a receipt and the yes that spends it. Default 4000 ms. */
  gapMs?: number;
  /** Refused confirmed calls of one tool in one session that still get a read-back; the next one stops it. Default 2. */
  refusals?: number;
};

/** Stable JSON: keys sorted, so {a,b} and {b,a} hash the same. */
function canonical(x: unknown): string {
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

const key = (session: string, tool: string, rest: Record<string, unknown>) => hash(`${session}\n${tool}\n${canonical(rest)}`).then((h) => "receipt:" + h);
const refusedKey = (session: string, tool: string) => hash(`${session}\n${tool}`).then((h) => "refused:" + h);

/** The words to read back: the action and every argument, in a fixed order. */
export function readbackText(tool: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map((k) => `${k.replace(/_/g, " ")}: ${typeof args[k] === "string" ? args[k] : canonical(args[k])}`);
  return `${tool.replace(/_/g, " ")}${parts.length ? ", " + parts.join("; ") : ""}`;
}

const FIRST = "Read the text back to the user word for word, not in your own words, and wait for a clear yes. Then call again with the same arguments and confirmed=true.";
const AGAIN = "Not sent yet. Read this exact text back to the user word for word and get a new yes, then call again with the same arguments and confirmed=true. The yes has to come after the read-back.";

export type Readback = { action: string; args: Record<string, unknown>; text: string; say: string };

export type Gate =
  | { run: true }
  | { run: false; readback: Readback }
  | { run: false; error: string; stop?: true };

type Receipt = { tool: string; at: number; turn?: string };

export async function gate(
  store: Store,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  o: GateOptions = {},
): Promise<Gate> {
  const { confirmed: _c, ...rest } = args;
  const k = await key(session, tool, rest);
  const rk = await refusedKey(session, tool);
  const refused = Number((await store.get(rk)) ?? 0);
  const cap = o.refusals ?? 2;
  const stop = (): Gate => ({
    run: false,
    stop: true,
    error:
      `STOP. ${tool} was refused ${cap + 1} times without a yes that matched the read-back, so it is off for this conversation. ` +
      "Don't call it again. Tell the user plainly that it did not go through, and why: the yes didn't match the exact read-back. Don't retry.",
  });
  if (refused > cap) return stop();

  const issue = async (say: string): Promise<Gate> => {
    await store.put(k, { tool, at: Date.now(), ...(o.turn !== undefined ? { turn: o.turn } : {}) } satisfies Receipt, TTL);
    return { run: false, readback: { action: tool, args: rest, text: readbackText(tool, rest), say } };
  };
  if (args.confirmed !== true) return issue(FIRST);

  const r = (await store.get(k)) as Receipt | undefined;
  const early = r && (o.turn !== undefined && r.turn !== undefined ? r.turn === o.turn : Date.now() - r.at < (o.gapMs ?? 4000));
  if (!r || early) {
    await store.put(rk, refused + 1, STOP_TTL);
    if (refused >= cap) {
      await store.delete(k);
      return stop();
    }
    // Too early keeps the receipt it has (and its turn); none issues one now.
    if (r) return { run: false, readback: { action: tool, args: rest, text: readbackText(tool, rest), say: AGAIN } };
    return issue(AGAIN);
  }
  await store.delete(k);
  // A yes that matched shows the flow works; a looping model never gets here.
  if (refused) await store.delete(rk);
  return { run: true };
}
