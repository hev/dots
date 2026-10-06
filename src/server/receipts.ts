// Act receipts: the server, not the model or the browser, decides whether an
// action runs. An act called without `confirmed` stores a receipt for exactly
// those arguments and returns a read-back. `confirmed: true` runs only if a
// receipt for the same session, tool and arguments is waiting; a changed
// draft needs a new yes. Idea from OpenDots' review receipts, enforced here.

import type { Store } from "./types.ts";

const TTL = 10 * 60;

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

async function key(session: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const { confirmed: _c, ...rest } = args;
  const bytes = new TextEncoder().encode(`${session}\n${tool}\n${canonical(rest)}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "receipt:" + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Gate =
  | { run: true }
  | { run: false; readback: { action: string; args: Record<string, unknown>; say: string } }
  | { run: false; error: string };

export async function gate(
  store: Store,
  session: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Gate> {
  const k = await key(session, tool, args);
  if (args.confirmed !== true) {
    const { confirmed: _c, ...rest } = args;
    await store.put(k, { tool, at: Date.now() }, TTL);
    return {
      run: false,
      readback: {
        action: tool,
        args: rest,
        say: "Read this exact action back and wait for a clear yes, then call again with the same arguments and confirmed=true.",
      },
    };
  }
  if ((await store.get(k)) === undefined) {
    return {
      run: false,
      error: "no read-back matches these arguments: read this exact version back and get a yes first",
    };
  }
  await store.delete(k);
  return { run: true };
}
