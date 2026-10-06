# dots

Voice-first assistants over your own sources. A dot says nothing it can't source,
and acts only after a spoken yes, enforced on the server.

Early. hev mind's hev dot and twc's talk mode are moving onto it.

```ts
import { defineDot, defineTool, http, local } from "@hevmind/dots/server";
import { geminiLive } from "@hevmind/dots/gemini-live";

const dot = await defineDot({
  name: "mine",
  persona: ({ capabilities, demo }) => `You are a dot. You can:\n${capabilities}`,
  voice: geminiLive({ apiKey: process.env.GEMINI_API_KEY! }),
  tools: [
    local([defineTool({ name: "today", description: "Today's plan.", run: () => ({ plan: "..." }) })]),
    http({ url: "http://127.0.0.1:8770/api/tool", tools: [/* declarations */] }),
  ],
  identity: async (req) => req.headers.get("tailscale-user-login"),
  logins: ["you@example.com"],
});

export default { fetch: dot.fetch }; // Workers; on Node, wrap in any fetch server
```

## The rules it enforces

- **Tool kinds.** `read` (the default), `act`, `private`, `display` and `slow`.
- **Acts need a read-back.** An act called without `confirmed` stores a receipt
  for those exact arguments and returns a read-back. `confirmed: true` runs only
  against a matching receipt, once. A changed draft needs a new yes. Unless
  `live: true`, confirmed acts dry-run.
- **Demo mode by default.** Every tool result is scrubbed before the model sees it:
  secrets, emails, IPs and codenamed clients, plus amounts in demo mode.
  Private mode, acts and display results need an allowed login.
- **Slow tools** return a job handle; the client polls `GET /api/job/<id>`.
- **Traces** use hev dot's JSONL line format, through a pluggable sink.

## Installing on a phone

`@hevmind/dots/install` makes a dot install as an app: its own icon, no browser
badge, and Chrome's install prompt. `manifest()` and `installRoutes()` serve a
manifest with 192, 512 and maskable icons plus a no-cache service worker;
`installHead()` gives the `<head>` tags; `installPrompt()` drives an install
button. `installProblems(origin, manifest)` says why a dot won't install.

The one thing code can't fix: **a dot must be on valid HTTPS.** Chrome won't
register a service worker behind a self-signed certificate, and without one,
Android makes a shortcut with a Chrome badge. On a tailnet, serve the dot
through `tailscale serve` (with HTTPS certificates on for the tailnet), not on
a raw IP.

## Packs and cards

A pack is one integration plugged in whole: its tools (under the same policy as
any other), the routes they need, a few lines of persona guidance, and chip
labels. A display tool returns `{ card }`: a title, a few lines, an image and a
link. The screen draws it, and the model hears only that it's up. Card links are
plain https, so on a phone they open the app that owns them.

```ts
import { maps } from "@hevmind/dots/maps";
import { screenRoutes } from "@hevmind/dots/client";

const places = maps({ apiKey: process.env.MAPS_API_KEY!, home: "Boulder, CO" });
const dot = await defineDot({ /* ... */ tools: [], packs: [places] });
const page = screenRoutes({ name: "mine", packs: [places] });
```

`maps()` gives `find_place`, `travel_time` and `show_map` (Places, Routes and
Static Maps on one key). Map images are served by the dot from ids `show_map`
made, so the key stays on the server.

**new** on the screen (or `/clear` typed) starts a fresh session: links, cards
and the log empty, the Live session and its resumption handle go, and the next
turn gets a new session id. The old session's trace ends with a `cleared` event.

## Routes

`GET /api/token`, `POST /api/tool`, `POST /api/trace`, `GET /api/job/<id>`.

## Slack

The same dot, in text, when someone @mentions the bot in one channel. Socket
Mode, so the host only connects out.

```ts
import { chat, memoryStore } from "@hevmind/dots/server";
import { geminiChat } from "@hevmind/dots/gemini-live";
import { slack } from "@hevmind/dots/slack";

const store = memoryStore();
await slack({
  chat: chat({ dot, model: geminiChat({ apiKey }), store, surface: "slack" }),
  store,
  botToken, appToken,          // xoxb- and xapp- (connections:write)
  channel: "C…",               // the only channel it answers in
  users: { "U…": "you@example.com" },
}).start();
```

A thread is a session: after the first mention, replies in the thread reach the
dot without another mention. Every tool call goes through the same policy as the
voice screen, so an act reads back in the thread and runs only on a yes from a
mapped user. The persona gets `surface: "slack"` to adjust its style.
`clear` in a thread makes the dot forget it (`chat.clear(ctx)` on any text
surface); a new thread is a new session anyway.

The app needs Socket Mode, the `app_mention` and `message.groups` events, and the
bot scopes `app_mentions:read`, `chat:write`, `groups:history` and `reactions:write`.

## Develop

Node 22.18+ runs the TypeScript directly.

```sh
npm test
npm run check
```
