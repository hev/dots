// Gemini TTS: text to WAV bytes in a prebuilt voice, for spoken cues. Use the
// voice the dot speaks in, so the cues sound like the dot. Ported from hev dot's tts().

export type GeminiSpeakOptions = {
  apiKey: string;
  voice: string;
  /** A bracketed direction prepended to the text, e.g. "[warm, relaxed, quick and natural] ". */
  style?: string;
  model?: string;
};

/** Wraps bare 24 kHz mono 16-bit PCM in a WAV header. */
export function wav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length, true); out.set(pcm, 44);
  return out;
}

export function geminiSpeak(o: GeminiSpeakOptions) {
  return async (text: string): Promise<Uint8Array> => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${o.model ?? "gemini-3.8-flash-tts"}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": o.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: (o.style ?? "") + text }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } },
      }),
    });
    if (!res.ok) throw new Error(`Gemini TTS answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const b64 = d.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) throw new Error("Gemini TTS sent no audio");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return String.fromCharCode(...raw.slice(0, 4)) === "RIFF" ? raw : wav(raw);
  };
}
