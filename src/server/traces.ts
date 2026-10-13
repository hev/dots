import type { TraceLine } from "./types.ts";

/** The text of the line the client opens every session with (kind `start`); the server stamps the build on it. */
export const SESSION_START = "session start";

/** What the client ships: `u` (user), `d` (dot), `tool` and `start` events. */
export type ClientEvent = {
  kind: "u" | "d" | "tool" | string;
  id?: string | number;
  ts?: string | number;
  text?: string;
  model?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  ms?: number;
  /** On a `u` event: thumbnails of the photos sent with it, as small data: URLs. Kept for the thread, not the trace. */
  photos?: string[];
  /** On a `t` event: the card or link that went up. */
  card?: unknown;
  url?: string;
};

export const SESSION = /^[0-9a-f-]{8,40}$/;

/** Client events to trace lines, in hev dot's JSONL format. Capped like hev dot's. */
export function toLines(session: string, events: ClientEvent[]): TraceLine[] {
  return events.slice(0, 200).map((e) => {
    const id = String(e.id ?? "").slice(0, 40);
    const line: TraceLine = {
      session_id: session,
      id,
      ts: e.ts ?? null,
      role: e.kind === "u" ? "user" : e.kind === "d" || e.kind === "tool" ? "assistant" : "event",
      text: (e.photos?.length ? `[${e.photos.length} photo${e.photos.length > 1 ? "s" : ""}] ` : "") + String(e.text ?? "").slice(0, 8000),
      model: e.model ?? null,
    };
    if (e.kind === "start") line.text = SESSION_START;
    if (e.kind === "tool") {
      line.text = "";
      line.tool_calls = [
        {
          id,
          name: String(e.name ?? ""),
          args: e.args ?? null,
          result: JSON.stringify(e.result ?? null).slice(0, 8000),
          is_error: Boolean(e.error),
          duration_ms: e.ms ?? null,
        },
      ];
    }
    return line;
  });
}
