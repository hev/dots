// A fixture dot for the UAT: fake voice and text model, no outside calls, no
// writes. It serves the real screen and the real routes at the build it's told.
// Prints "listening <port>" once it's up. Env: UAT_COMMIT (full sha), PORT (default: free).

import { createServer } from "node:http";
import { screenRoutes } from "../src/client/index.ts";
import { appTools, defineDot, defineTool, local, type ChatModel } from "../src/server/index.ts";

const commit = process.env.UAT_COMMIT ?? "0".repeat(40);
const version = { commit, short: commit.slice(0, 7), built: new Date().toISOString() };
const apps = { notes: { title: "Notes", html: "<h2>Notes</h2><p id='note'>fixture app</p>", script: "api.on('card', () => { el.dataset.card = '1'; }); return () => { window.__appClosed = (window.__appClosed || 0) + 1; };" } };

const model: ChatModel = {
  name: "fixture",
  async turn({ history }) {
    const last = history.at(-1);
    if (last?.role === "user" && /notes/i.test(last.text)) return { calls: [{ id: "c1", name: "open_app", args: { app: "notes" } }] };
    return { text: last?.role === "tool" ? "Opened." : "You said: " + (last?.role === "user" ? last.text : "") };
  },
};

const dot = await defineDot({
  name: "uat",
  persona: ({ capabilities }) => `A fixture dot.\n${capabilities}`,
  voice: { name: "fixture", mint: async () => ({ error: "fixture has no voice" }) },
  tools: [local([defineTool({ name: "today", description: "Today's plan.", run: () => ({ plan: "fixture" }) })]), appTools({ notes: "a scratch view" })],
  chat: model,
  identity: async () => "uat@example.com",
  logins: ["uat@example.com"],
  version,
});
const page = screenRoutes({ name: "uat", subtitle: "fixture", apps, version });

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host}${req.url}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Response(req as never).arrayBuffer();
  const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body });
  const out = page(request) ?? (await dot.fetch(request));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (out.body) for await (const chunk of out.body as never as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
});
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log("listening " + (server.address() as { port: number }).port));
