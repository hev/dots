// Spoken cues: a few short lines in the dot's own voice for the moments the
// screen marks (waking, ready, bye, a lost line, reconnecting, unreachable), so
// someone in headphones can follow along without looking. Several takes per
// moment and a random pick each time, so it never sounds canned. Each take is
// spoken once, cached, and served as WAV from GET <base>/cue?kind=&n=.
// Pair with screenRoutes({ cues: true }). Ported from hev dot.

export type CueKind = "waking" | "ready" | "bye" | "lost" | "reconnect" | "unreachable";

/** Text to WAV bytes, e.g. geminiSpeak() from the gemini-live module. */
export type Speak = (text: string) => Promise<Uint8Array>;

/** Where takes are kept between restarts. Memory by default. */
export type CueCache = {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, wav: Uint8Array): Promise<void>;
};

export const CUE_LINES: Record<CueKind, string[]> = {
  waking: ["One sec.", "Give me a second.", "Hang on, waking up.", "Just a moment.", "Okay, one sec.", "Bear with me."],
  ready: ["Okay, I'm listening.", "Go ahead.", "I'm here. What's up?", "Okay, all ears.", "Go on.", "I'm with you."],
  bye: ["Talk soon.", "Bye for now.", "Okay, I'll leave you to it."],
  lost: ["Lost the line there. Tap me to get me back.", "Sorry, I dropped out. Give me a tap."],
  reconnect: ["Hang on, back in a second.", "One sec, reconnecting."],
  unreachable: ["Sorry, I can't reach the server right now.", "I can't get through right now."],
};

export function memoryCueCache(): CueCache {
  const m = new Map<string, Uint8Array>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
}

export function cueRoutes(o: { speak: Speak; lines?: Partial<Record<CueKind, string[]>>; cache?: CueCache; base?: string; key?: string }) {
  const lines = { ...CUE_LINES, ...o.lines };
  const cache = o.cache ?? memoryCueCache();
  const path = (o.base ?? "/api") + "/cue";
  const pending = new Map<string, Promise<Uint8Array>>();
  /** The cache key changes with the voice (pass it as `key`), so a new voice gets new takes. */
  const take = (text: string) => {
    const k = `${o.key ?? ""}|${text}`;
    let p = pending.get(k);
    if (!p) {
      p = (async () => {
        const hit = await cache.get(k);
        if (hit) return hit;
        const wav = await o.speak(text);
        await cache.put(k, wav);
        return wav;
      })().finally(() => pending.delete(k));
      pending.set(k, p);
    }
    return p;
  };
  return {
    /** Speaks every take ahead of time, so the first tap doesn't wait on TTS. */
    async warm(log: (m: string) => void = () => {}) {
      for (const [kind, texts] of Object.entries(lines))
        for (const t of texts) await take(t).catch((e) => log(`cue ${kind} "${t}" failed: ${e}`));
    },
    routes: async (req: Request): Promise<Response | null> => {
      const u = new URL(req.url);
      if (req.method !== "GET" || u.pathname !== path) return null;
      const texts = lines[u.searchParams.get("kind") as CueKind];
      if (!texts?.length) return Response.json({ error: "no such cue" }, { status: 404 });
      const n = Number(u.searchParams.get("n"));
      const text = texts[(Number.isInteger(n) && n >= 0 ? n : Math.floor(Math.random() * texts.length)) % texts.length]!;
      try {
        const wav = await take(text);
        return new Response(wav as BodyInit, { headers: { "content-type": "audio/wav", "cache-control": "no-store", "x-spoken": encodeURIComponent(text) } });
      } catch (e) {
        return Response.json({ error: String(e).slice(0, 200) }, { status: 502 });
      }
    },
  };
}
