import assert from "node:assert/strict";
import { test } from "node:test";
import { defineDot, memoryStore } from "../src/server/index.ts";
import type { ChatModel, Msg } from "../src/server/chat.ts";
import { contents } from "../src/gemini-live/chat.ts";

test("a typed turn's photos reach the model inline, and bad ones are refused", async () => {
  const seen: Msg[][] = [];
  const model: ChatModel = { name: "m", turn: async (r) => (seen.push(structuredClone(r.history)), { text: "a cherry tree" }) };
  const dot = await defineDot({ name: "d", persona: () => "", voice: { name: "x", mint: async () => ({}) }, tools: [], chat: model, identity: async () => "d@x", logins: ["d@x"], store: memoryStore() });
  const post = (body: unknown) => dot.fetch(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }), undefined, { waitUntil: () => {} });
  const session = "0123456789abcdef0123456789abcdef";
  const ok = await (await post({ session, safe: false, images: [{ mimeType: "image/jpeg", data: "QUJD" }] })).text();
  assert.match(ok, /a cherry tree/);
  const user = seen[0]!.at(-1) as { text: string; images: unknown[] };
  assert.equal(user.text, "What do you make of this?");
  assert.deepEqual(contents([user as Msg])[0]!.parts[0], { inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
  assert.equal((await post({ session, safe: false, images: [{ mimeType: "image/gif", data: "QUJD" }] })).status, 400);
  assert.equal((await post({ session, safe: false, images: Array(5).fill({ mimeType: "image/png", data: "QUJD" }) })).status, 400);
});
