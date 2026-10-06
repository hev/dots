// Gemini's text model with function calling, for text surfaces. Same family as
// the Live voice, so a dot sounds like itself in Slack.

import type { ChatModel, Msg } from "../server/chat.ts";
import { declarations } from "./index.ts";

export type GeminiChatOptions = { apiKey: string; model?: string };

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export function contents(history: Msg[]) {
  return history.map((m) => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] as Part[] };
    if (m.role === "model") {
      const parts: Part[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.calls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: m.results.map((r) => ({
        functionResponse: {
          name: r.name,
          response: r.result && typeof r.result === "object" && !Array.isArray(r.result) ? (r.result as Record<string, unknown>) : { result: r.result },
        },
      })) as Part[],
    };
  });
}

export function geminiChat(o: GeminiChatOptions): ChatModel {
  const model = o.model ?? "gemini-3.8-flash";
  return {
    name: model,
    async turn({ system, history, tools }) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": o.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: contents(history),
          tools: tools.length ? [{ functionDeclarations: declarations(tools) }] : undefined,
        }),
      });
      if (!res.ok) throw new Error(`gemini answered ${res.status}`);
      const data = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[] };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.flatMap((p) => ("text" in p ? [p.text] : [])).join("").trim();
      const calls = parts.flatMap((p, i) =>
        "functionCall" in p ? [{ id: `c${Date.now()}${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }] : [],
      );
      return { text: text || undefined, calls: calls.length ? calls : undefined };
    },
  };
}
