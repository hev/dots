// Gemini Live: a one-session ephemeral token with persona, voice and tools
// locked server-side, so the key never reaches the phone and the phone can't
// change the setup. Ported from hev dot's mint_token().
//
// Gotchas carried over from hev dot:
// - responseModalities goes inside generationConfig
// - tokens are single-use: reconnect with the session resumption handle

import type { JSONSchema, SessionSetup, ToolDecl, VoiceProvider } from "../server/types.ts";

export type GeminiLiveOptions = {
  apiKey: string;
  model?: string;
  voice?: string;
  silenceMs?: number;
  /** Token lifetime in minutes. */
  ttl?: number;
};

/** Gemini's function declarations use OpenAPI-style upper-case types. */
function schema(s: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  if (s.type) out.type = s.type.toUpperCase();
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, schema(v)]));
  if (s.items) out.items = schema(s.items);
  return out;
}

export function declarations(tools: ToolDecl[]) {
  return tools.map(({ name, description, parameters }) =>
    parameters ? { name, description, parameters: schema(parameters) } : { name, description },
  );
}

export function liveSetup(o: GeminiLiveOptions, setup: SessionSetup) {
  return {
    model: o.model ?? "models/gemini-3.8-live",
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice ?? "Algenib" } } },
    },
    systemInstruction: { parts: [{ text: setup.persona }] },
    tools: [{ functionDeclarations: declarations(setup.tools) }],
    realtimeInputConfig: { automaticActivityDetection: { disabled: false, silenceDurationMs: o.silenceMs ?? 600 } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
  };
}

export function geminiLive(o: GeminiLiveOptions): VoiceProvider {
  return {
    name: "gemini-live",
    async mint(setup) {
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
      const body = {
        uses: 1,
        expireTime: iso(now + (o.ttl ?? 30) * 60_000),
        newSessionExpireTime: iso(now + 2 * 60_000),
        bidiGenerateContentSetup: liveSetup(o, setup),
      };
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
        method: "POST",
        headers: { "x-goog-api-key": o.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`gemini token mint failed: ${res.status}`);
      const { name } = (await res.json()) as { name: string };
      return { token: name, model: body.bidiGenerateContentSetup.model };
    },
  };
}
export { geminiChat, type GeminiChatOptions } from "./chat.ts";
