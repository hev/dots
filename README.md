# dots

Voice-first assistants over your own sources. A dot says nothing it can't source,
and acts only after a spoken yes, enforced on the server.

Early. hev mind's hev dot and twc's talk mode are moving onto it.

```ts
import { defineDot, defineTool, http, local } from "@hevmind/dots/server";
import { geminiLive } from "@hevmind/dots/gemini-live";

const dot = await defineDot({
  name: "mine",
  persona: ({ capabilities, barsafe }) => `You are a dot. You can:\n${capabilities}`,
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
- **Bar-safe by default.** Every tool result is scrubbed before the model sees it:
  secrets, emails, IPs and codenamed clients, plus amounts in bar-safe mode.
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

## Routes

`GET /api/token`, `POST /api/tool`, `POST /api/trace`, `GET /api/job/<id>`.

## Develop

Node 22.18+ runs the TypeScript directly.

```sh
npm test
npm run check
```
