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

## Text, sub-agents and info

Give `defineDot` a `chat` model and typed questions on the screen are answered in
text (`POST /api/chat`, streamed), so typing never wakes the voice. A `subagent`
adds a slow `deep_think` tool: a stronger model works the question through the
dot's read tools (never acts, displays or itself) and the voice relays its
answer. `inbox` names the address the dot reads mail from.

```ts
const dot = await defineDot({
  /* ... */
  chat: geminiChat({ apiKey }),
  subagent: { model: geminiChat({ apiKey, model: "gemini-3.1-pro-preview" }), when: "budgets, trends" },
  inbox: "me@example.com",
});
const page = screenRoutes({ name: "me", orb: "/icon-512.png" });
```

The screen's **info** pane lists the tools (from `GET /api/info`) and the inbox.
`orb` puts the dot's own art in the middle of the screen.

## Sound and modes

The screen plays earcons on its own: a tick when a tool starts, a soft pulse
every 1.6s while one is running, a chord when a card or link goes up, and a low
pair on an error. `cues: true` adds short spoken lines in the dot's own voice for
waking, ready, bye, a lost line, reconnecting and unreachable; the mic opens only
after "ready" finishes, so the dot doesn't hear itself. The dot serves them:

```ts
import { cueRoutes } from "@hevmind/dots/cues";
import { geminiSpeak } from "@hevmind/dots/gemini-live";

const cues = cueRoutes({ speak: geminiSpeak({ apiKey, voice: "Sulafat", style: "[warm, relaxed] " }), key: "Sulafat" });
cues.warm();                                    // speak every take once, ahead of the first tap
const page = screenRoutes({ name: "me", cues: true, modes: false });
// chain cues.routes(req) ahead of dot.fetch
```

`design` takes the dot past colors: `head` (e.g. a Google Fonts link), `css`
(after the screen's own, so it wins) and `decor` (HTML drawn behind the app that
never takes taps: art, petals, a pattern).

`greeting` is a note the model gets when a fresh session is ready ("Open with a
haiku"). `sounds` swaps the earcons' notes. `design.script` is the dot's own JS;
the screen fires `dot:ready`, `dot:greet`, `dot:tool`, `dot:done`, `dot:card`,
`dot:error` and `dot:bye` on `window` for it. A card can carry a `body` (a poem,
line breaks kept) and a `style` class for the dot's CSS.

`modes: false` hides the demo/private switch and always runs private, for a dot
with nothing worth hiding. The server still checks the login.

## Photos

The screen's 📷 opens the phone's chooser, camera or photo library. Photos are
shrunk on the phone (1280px JPEG) and wait as thumbnails. In a voice session
they go in at once, inline in a turn (a Live `realtimeInput` video frame isn't
seen by a typed turn); otherwise they go with the next typed question, as
`images` on `POST /api/chat` (up to four, JPEG, PNG or WebP, under 5 MB each).
The chat history keeps the photos of the last two messages that had them.

## Themes, haiku and restyling

`@hevmind/dots/theme` is a `Theme` type: everything about how a dot looks, sounds
and greets its person, as data (`screenOptions(theme)` makes the screen options).
`@hevmind/dots/haiku` gives `show_haiku`, a card the theme styles, and
`HAIKU_CRAFT` for the persona; a greeting like "open with a haiku" uses it.
`@hevmind/dots/restyle` lets the person redecorate the dot out loud: `restyle`
starts a factory session that rebuilds `theme/` and `web/` and opens a PR, and
`ship_theme`, after a yes, ships it only if every file is under those two and
the theme code passes `themeProblems()`. hev/dasha is the reference repo shape.
`memo` (from `/server`) caches slow outside calls and shares calls in flight.

## Apps

An app is a named view the dot owns, mounted over the chat in the same page. The
chat keeps running underneath: the Live session, transcript, chips, links and
pending jobs are untouched, and the voice keeps listening. While an app is open
the orb shrinks to a pill at the top right that shows the dot's state; tapping
it returns to the chat. Each open pushes a history entry, so Android back,
swipe-back and back in an installed PWA close the app instead of leaving the page.

```ts
import { appTools, defineDot } from "@hevmind/dots/server";
import { screenRoutes } from "@hevmind/dots/client";

const dot = await defineDot({
  /* ... */
  tools: [/* ..., */ appTools({ budget: "the month's spending, when asked to see it" })],
});
const page = screenRoutes({
  name: "mine",
  apps: {
    budget: {
      title: "Budget",
      html: `<h2>Budget</h2><div id="rows"></div>`,
      css: `[data-app="budget"] h2 { margin: 0 }`,
      // a function body of (el, api); return a cleanup function if it needs one
      script: `
        api.on("card", (e) => { el.querySelector("#rows").textContent = e.detail.card.title; });
        api.on("tool", (e) => console.log("running", e.detail.name));
        return () => console.log("closed");`,
      // or: module: "/budget.js"  (an ES module exporting mount(el, api), likewise returning a cleanup)
    },
  },
});
```

- **The app is the dot's.** `html`, `css`, `script` and `module` are trusted
  strings from the dot's author; the screen owns the container (`el`) and gives
  the app `api`: `{ name, el, on(event, fn), open(name), close() }`. `api.on`
  listens for the screen's `dot:*` events (`ready`, `greet`, `tool`, `done`,
  `card`, `error`, `bye`, plus `app` with `{ name }` or `null`) and unhooks them
  when the app closes. The app is torn down on close and mounted fresh on open.
- **Opening.** `appTools(...)` adds the `open_app` and `close_app` display tools,
  so the voice opens an app ("show me the budget") and closes it ("close that",
  "go back"). A card can carry `app: { name, label }`, drawn as a button that
  opens it. `window.dotApps.open(name)` and `.close()` do the same from the
  dot's own script. Opening another app while one is open swaps it in place, so
  one back still returns to the chat. These are display tools, so they follow
  the display policy: allowed logins only.
- **Closing.** The pill, back, `close_app`, and **new** (a fresh session) all close it.

## Version tag

`defineDot({ version })` and `screenRoutes({ version })` take `{ commit, short, built }`
(`built` is ISO 8601). The screen shows a small always-visible tag, short sha and
date, in the bottom-left corner; tapping it copies the full commit. `GET /api/info`
returns it as `version`, and the trace for each session opens with a `session
start` line carrying it. `gitVersion()` from `/version` reads it from the checkout
at startup (Node only, so it sits outside `/server`; on Workers pass the commit in
at build time).

```ts
import { gitVersion } from "@hevmind/dots/version";

const version = gitVersion(); // { commit, short, built } or undefined outside git
const dot = await defineDot({ /* ... */ version });
const page = screenRoutes({ name: "mine", version });
```

## Routes

`GET /api/token`, `POST /api/tool`, `POST /api/chat`, `POST /api/trace`, `GET /api/job/<id>`, `GET /api/info`.

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

`scripts/uat` is the repo's acceptance check for Mini, run in a fresh checkout
with `UAT_COMMIT` (the 40-char sha) and `UAT_DIR` (evidence dir) set. It prints
one JSON line, `{"passed", "version", "checks"}`.

- `scripts/uat preview` installs, runs the tests and type check, starts a
  fixture dot (`scripts/uat-server.ts`: fake voice and text model, no live
  writes) on a free loopback port, checks it over HTTP and in headless
  Chromium (apps open, back closes, the session survives), and stops it.
  Playwright must be resolvable (`NODE_PATH` or a global install).
- `scripts/uat live <base-url>` is read-only: `/api/info` must report
  `UAT_COMMIT`, and the screen must serve with that commit's tag.
