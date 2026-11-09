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

## Try it with no keys

A fixture dot with a fake text model and no outside calls ships with the repo.
It serves the real screen and the real routes:

```sh
git clone https://github.com/hev/dots && cd dots
npm ci
PORT=8787 node scripts/uat-server.ts     # prints "listening 8787"
curl -s localhost:8787/api/info
curl -s localhost:8787/api/chat -d '{"text":"hello","session":"0123456789abcdef"}'
# {"reply":"You said: hello"}
```

Open http://127.0.0.1:8787/ for the screen. Voice needs a real
`VoiceProvider` (`geminiLive` with a Gemini API key); typed chat works without one.

## The rules it enforces

- **Tool kinds.** `read` (the default), `act`, `private`, `display` and `slow`.
- **Acts need a read-back.** An act called without `confirmed` stores a receipt
  for those exact arguments and returns a read-back (`text` to say word for word,
  and a `say` instruction). `confirmed: true` runs only against a matching
  receipt, once. A changed draft needs a new yes. Unless `live: true`, confirmed
  acts dry-run. See [Act receipts](#act-receipts) for how it keeps models from looping.
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

## Act receipts

Models (Gemini Live especially) skip the unconfirmed call, read back in their own
words, and retry with slightly reworded arguments. The server doesn't let that loop:

- **A confirmed call with no receipt doesn't run.** It stores a receipt for those
  exact arguments and answers with the read-back, `say` starting "Not sent yet.
  Read this exact text back and get a new yes". The next yes then matches.
- **The yes must come after the read-back.** On a surface that knows its turns
  (the chat loop sets `ctx.turn` per user message: the screen's typed chat,
  Slack), a receipt is only accepted from an earlier turn. The voice screen
  can't tell the server where a user turn starts (Live's transcriptions can land
  after the tool call), so there a receipt is only accepted `gapMs` after it was
  issued: default 4 s, shorter than a spoken read-back plus a spoken yes, longer
  than a model calling straight back.
- **Refusals are capped.** After `refusals` (default 2) refused confirmed calls
  of one tool in one session, the next one answers with a final `STOP.` error:
  stop, tell the user plainly it didn't go through and why, don't retry. The
  tool stays off for that session (30 minutes); a new thread starts clean.
- **The act prompt comes with the tools.** `capabilities` ends with the rules
  (`ACT_RULES`) whenever a dot has an act: always call first without
  `confirmed`, read the server's `text` word for word, never a paraphrase. Act
  declarations get a described `confirmed` parameter if they leave it out.

```ts
const dot = await defineDot({ /* ... */ receipts: { gapMs: 4000, refusals: 2 } });
```

## Threads

The screen's ☰ opens a drawer of this user's past threads, newest first, with
each one's first line and when it was last used. Tapping one resumes it: its
transcript (with photo thumbnails) comes back, the session id carries on, so
typed turns keep their history, and a Live session started in it gets the last
lines as context. **new thread** in the drawer (or `/clear` typed) starts fresh:
links, cards and the log empty, the Live session and its resumption handle go,
and the next turn gets a new session id. The old session's trace ends with a
`cleared` event. The drawer works at phone width, from the keyboard (Escape
closes it) and with back or swipe-back, which close it.

Threads are kept in the dot's `Store` per verified login (`GET /api/threads`,
`GET /api/threads/<id>`), for 30 days: only the turns (what was said, photo
thumbnails, cards and links), secrets stripped as in traces. A thread belongs to
whoever wrote it first; nobody else can read it or add to it. They read back
in the screen's mode, so in demo mode a private thread's amounts are masked.
Without an identity there are no threads. Slack threads stay in Slack.

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

The screen's header is ☰, the wordmark, the mode switch (a lock: shut in
private mode, open in demo, named "private mode" / "demo mode" for screen
readers) and a compact **i**. It fits one row on a 360px phone, with 40px tap
targets. **i** opens the info pane: the tools (from `GET /api/info`), the inbox,
a **log** row that opens this session's log (Escape, back or close return to
info) and the Build line.
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

`defaultMode: "private"` starts the screen in private mode (default `"demo"`).
The person's own pick, kept on the device, still wins, and the server still
refuses private mode to anyone not allowed; the screen then drops back to demo.
Switching mode applies to the next typed turn, and restarts an open Live session
in the new mode (without its resumption handle, so private answers don't carry
into demo).

`wordmark: ["hev", "dot"]` puts the blinking cursor inside the name (hev▌dot).
By default it's the name, then the cursor.

## Photos

The screen's 📷 opens the phone's chooser, camera or photo library. Photos are
shrunk on the phone (1280px JPEG) and wait as thumbnails. In a voice session
they go in at once, inline in a turn (a Live `realtimeInput` video frame isn't
seen by a typed turn); otherwise they go with the next typed question, as
`images` on `POST /api/chat` (up to four, JPEG, PNG or WebP, under 5 MB each).
The chat history keeps the photos of the last two messages that had them.
Once sent, they show as thumbnails in the user's turn, under the orb and in the
log, and a small thumbnail of each (`thumb`, a data: URL) is kept in the thread;
the trace notes only how many there were.

## Themes, haiku and restyling

`@hevmind/dots/theme` is a `Theme` type: everything about how a dot looks, sounds
and greets its person, as data (`screenOptions(theme)` makes the screen options).
`@hevmind/dots/haiku` gives `show_haiku`, a card the theme styles, and
`HAIKU_CRAFT` for the persona; a greeting like "open with a haiku" uses it.
`@hevmind/dots/restyle` lets the person redecorate the dot out loud: `restyle`
starts a factory session that rebuilds `theme/` and `web/` and opens a PR, and
`ship_theme`, after a yes, ships it only if every file is under those two and
the theme code passes `themeProblems()`. The repo shape it expects is in the
header of `src/restyle/index.ts`.
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
- **Closing.** The pill, back, `close_app`, and switching thread (**new thread**, or resuming one) all close it.

## Version tag

`defineDot({ version })` and `screenRoutes({ version })` take `{ commit, short, built }`
(`built` is ISO 8601). The info pane's Build line shows the short sha and date;
tapping it copies the full commit. `GET /api/info`
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

A dot with releases adds `semver` (e.g. `{ ...gitVersion(), semver: "1.4.0" }`):
the Build line then shows `1.4.0 · date`, with the short sha in its title and
`data-sha`, and a tap copies `1.4.0 <commit>`. The short sha stays at the top of the log and on the log's `start` event, for
issue reports. Anything that isn't semver is ignored and the sha shows.

## Routes

`GET /api/token`, `POST /api/tool`, `POST /api/chat`, `POST /api/trace`, `GET /api/job/<id>`, `GET /api/info`, `GET /api/threads`, `GET /api/threads/<id>`.
The prefix is `base` (default `/api`). Who is calling comes from the dot's
`identity` adapter, never from the body.

### `POST /api/chat`

One typed turn, answered by the dot's text model through the same persona,
tools and policy as voice. The body is JSON:

| field | | |
|---|---|---|
| `text` | string | What the user said; trimmed, cut at 4000 characters. |
| `session` | string | Required. 8 to 40 of `0-9a-f-` (a UUID works). The conversation's history and act receipts are kept per session. |
| `safe` | boolean | Demo mode unless exactly `false`. `false` needs an allowed login. |
| `model` | string | Optional. An id from `chatModels`; left out, the default model answers. |
| `images` | array | Optional. Up to four `{ mimeType, data, thumb? }`: JPEG, PNG or WebP, base64 without a `data:` prefix, under 5 MB each. |

Errors before the turn starts are plain JSON with a status: 404 `{ error }` when
the dot has no text model, 400 for a bad session, an unknown `model`, bad
images or an empty `text`, and 403 when private mode isn't allowed.

Otherwise the answer is `200`, `content-type: application/x-ndjson`: one JSON
object per line, streamed as the turn runs, ending with exactly one `reply` or
`error` line.

```
{"slow":"deep_think"}                                   a slow tool started; say it's working
{"display":{"card":{"title":"…"}},"name":"show_card"}  a display tool's result: a card, a link or an app to show
{"reply":"Here's the plan."}                            the dot's answer; the stream ends
{"error":"…"}                                           the turn failed; the stream ends
```

The model sees only `{ shown: true }` for a display result, so the client must
draw it. An act answers with a read-back in `reply`; the user's yes is the next
turn in the same session, and the server checks it against the receipt. To
forget a session, start a new `session` id.

### `GET /api/info`

`{ name, inbox, text, defaultModel, models: [{ id, name }], version, tools: [{ name, kind, description }] }`.
`text` says whether `POST /api/chat` has a model; `models` lists the ids it accepts.

### `POST /api/tool`

`{ name, args, safe, session }` runs one tool through the policy, for a client
driving its own model (the voice screen does). The answer is the tool's
result, redacted, or `{ error }`; a slow tool answers `{ job, status: "working" }`
and `GET /api/job/<id>` gives `{ status: "done", result }` when it's finished.

### Your own text model

A text model is any `ChatModel` (from `/server`): a `name` and one `turn`
call. The chat loop owns history, tool calls and policy; the adapter only
translates.

```ts
import type { ChatModel } from "@hevmind/dots/server";

const mine: ChatModel = {
  name: "my-provider/model-id",
  async turn({ system, history, tools }) {
    // history: { role: "user", text, images? } | { role: "model", text?, calls?, raw? } | { role: "tool", results }
    // Answer with text, or with calls: [{ id, name, args }] for the loop to run and send back.
    return { text: "…" };
  },
};
```

`raw` is returned to the same adapter on the next turn unchanged, for
providers that need their own turn back (Gemini's thought signatures).

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
  Chromium (apps open, back closes, the session survives; the threads drawer
  lists, resumes and starts fresh, and back and Escape close it; at 360px, light
  and dark, the header fits one row with 40px targets in the order ☰, wordmark,
  lock, i, private mode shows the lock, the build sits in info, and the log
  opens from info and closes back into it), and stops it. Header and info
  screenshots go to `UAT_DIR`.
  Playwright must be resolvable (`NODE_PATH` or a global install).
- `scripts/uat live <base-url>` is read-only: `/api/info` must report
  `UAT_COMMIT`, and the screen must serve with that commit's tag.

## Outbound phone calls

`@hevmind/dots/phone` dials with Twilio REST, serves `<Connect><Stream>` TwiML,
and bridges Media Streams to server-side Gemini Live. The server enforces an
exact E.164 number allowlist, one active call, a length cap, synchronous answering
machine detection, signed callbacks/upgrades, and a single-use stream token
bound to the call SID. Only `AnsweredBy=human` connects; voicemail, fax and unknown
results hang up. Live is off by default, so `dial()` returns a dry-run summary
without contacting either service.

```ts
import { phone } from "@hevmind/dots/phone";
import type { PhoneSocket } from "@hevmind/dots/phone";

// Provided by your host's WebSocket adapter; resolves when the connection opens.
declare function connectSocket(url: string): Promise<PhoneSocket>;
const calls = phone({
  live: false, // Enable only on the server after wiring the host below.
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  from: "+14155550100",
  allowlist: ["+14155550101"],
  publicUrl: "https://phone.example.com",
  maxSeconds: 120,
  gemini: { apiKey: process.env.GEMINI_API_KEY!, model: "models/your-live-model" },
  persona: "You are my assistant. Keep phone replies brief.",
  connectGemini: connectSocket,
  onError: error => console.error(error),
});

// Call from a trusted server action, after the dot's normal read-back/yes policy.
const result = await calls.dial("+14155550101");
// Your fetch router delegates POST /phone/answer and /phone/status:
const route = (request: Request) => calls.handle(request);

// In the host's GET /phone/stream upgrade handler:
async function acceptStream(request: Request, accept: () => PhoneSocket) {
  if (!await calls.authorizeStream(request)) return new Response("Forbidden", { status: 403 });
  const socket = accept();
  await calls.stream(request, socket);
}
```

The host owns HTTP/WebSocket upgrade mechanics and implements `PhoneSocket`
(`send`, `close`, `onMessage`, `onClose`, `onError`); messages arrive as decoded
JSON strings. Register stream handlers before delivering buffered start frames.
Keep Twilio/Gemini credentials on the server. Use the exact externally visible
HTTPS URL when constructing requests behind a proxy, preserving query strings
and every form field for signature verification. The public origin must use
standard HTTPS port 443. Serve the matching WSS path with a valid certificate.
Gemini setup stays server-owned and exposes no tools; its key is never sent to
Twilio or the client. Audio is raw mu-law at 8 kHz on Twilio, PCM16 at 16 kHz into
Gemini, and PCM16 at 24 kHz out, converted incrementally across frame boundaries.
Interrupted Gemini output clears Twilio's playback buffer.

Run one long-lived coordinator per caller and route all callbacks and streams to
it. The in-memory lock is per adapter instance; do not create one per request or
run multiple replicas for the same caller. Twilio's `TimeLimit` also enforces the
cap if the host stops. A lost dial response or failed hangup keeps the slot locked
until a signed terminal callback or successful `hangup()` reconciles it; do not
blindly retry a dial. Stream tokens expire with the call and cannot reconnect.
`npm test` exercises these paths with fake REST and sockets; it makes no real calls.

Protocol references: [Twilio request signatures](https://www.twilio.com/docs/usage/security),
[Media Streams messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages),
and [Gemini Live WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).

### Phone runtime boundary

`src/phone/core.ts` owns fetch-based Twilio REST/webhook handling, policy and the
Gemini protocol. `audio.ts` owns typed-array audio conversion. `transport.ts`
defines `PhoneSocket`; `index.ts` is the public facade. None imports Node modules,
`ws`, an HTTP server, or Workers APIs. `npm run check` also compiles this dependency
graph with web platform libraries and **no Node types** (`tsconfig.phone.json`).

Implement the transport in your host adapter: Node may use `ws` and an HTTP
server; Cloudflare may use Worker upgrades and a Durable Object. Those APIs stay
outside the core. `connectGemini`, `fetch`, and `schedule` can be supplied by that
adapter. No tunnel or deployment provider is built into the phone package.

A Durable Object can own the single coordinator and its sockets. Preserve its
in-memory call state and timer execution throughout an active call; hibernation
or eviction requires host-owned persistence/recovery before accepting another
dial. The core does not implement Durable Object storage, alarms or hibernation.
A plain stateless Worker instantiated per request cannot enforce the one-call
lock. The web-only type check establishes the API boundary; it is not a deployed
Cloudflare acceptance test. Route and deployment choices remain host-owned.

## Text-first screen and model selection

The shared screen opens in silent text chat. Enter sends, Shift+Enter adds a
line, and the Send button works on mobile. Only the Voice button starts voice;
a missing or failing text adapter never opens a microphone, audio context or
voice connection. Display cards, links and apps remain available in text chat.

Configure `chat` for a single adapter. For a picker, configure `chatModels`
with public IDs mapped to real `ChatModel` adapters. `chat` is the default;
without it, the first allowlisted adapter is the default. All choices use the
same server tools, identity, redaction and act receipts. The screen obtains
names and availability from `GET /api/info` and sends the selected ID with
`POST /api/chat`; unknown IDs fail before model execution. Provider keys stay
on the server. Adapter names should report verified provider model identifiers.
Do not label an adapter as a requested model unless that provider capability has
been verified. In particular, a consumer requesting Opus 5.5 must verify its
provider identifier and availability in its own deployment; the framework
supplies no invented alias or substitute provider.

Existing consumers using `chat`, `screenRoutes`, display tools and act receipts
need no configuration migration. Text chat without an adapter reports
unavailability. Voice remains an explicit optional path.
