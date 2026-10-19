// The voice screen: one page that talks to a dot. Tap the dot, speak, and it
// answers over Gemini Live with the persona and tools the server locked into the
// token. Tool calls go to the dot's own /api/tool with the session id, so acts
// read back and run only on a matching yes; slow tools poll /api/job; display
// tools ({url, label}) put a link on screen and the model hears only that it's up.
// Typed questions are answered in text (POST /chat, when the dot has a text
// model), so typing never wakes the voice. The header is ☰, the wordmark, the
// mode lock and "i". "i" opens info: the dot's tools, the inbox it reads, the log
// of this session and the build (tap to copy). ☰ opens the threads drawer: this user's past sessions (from
// GET /api/threads), newest first; a tap resumes one (its transcript and session
// id), and "new thread" (or typing /clear) starts fresh: the screen empties, the
// Live session and its resumption handle go, and the next turn gets a new session id.
//
// Earcons mark tool calls (a tick to start, a soft pulse while checking, a
// chord for a card or link, a low pair for an error). With `cues`, short spoken
// lines in the dot's own voice (from cueRoutes) mark waking, ready, bye and a
// lost line, so it can be followed in headphones.
//
// Apps (ScreenOptions.apps) are the dot's own views mounted over the chat in this
// same page; see apps.ts. While one is open the orb becomes a pill, and back closes it.
//
// Extracted from hev dot's web/index.html, minus what's hev mind's own
// (sub-agents, dead-air nuggets). A dot serves it with
// `screenRoutes(opts)`, chained ahead of `dot.fetch`.

import { installHead, type InstallOptions } from "../install/index.ts";
import type { Pack, Version } from "../server/types.ts";
import { APPS } from "./apps.ts";

export type ScreenOptions = {
  /** Shown as the wordmark and the page title. */
  name: string;
  /** The wordmark in two parts, with the blinking cursor between them: ["hev", "dot"] draws hev▌dot. Default the name, then the cursor. */
  wordmark?: [string, string];
  /** Under the wordmark, e.g. "finance". */
  subtitle?: string;
  /** Who the dot talks to, for the app's notes to the model. Default "the user". */
  user?: string;
  /** Friendly names for tools on the chips, e.g. { spend: "your spending" }. */
  labels?: Record<string, string>;
  /** The dot's packs, for their chip labels. */
  packs?: Pack[];
  /** The dot's routes. Default "/api". */
  base?: string;
  /** Accent color. Default hev dot's signal orange. */
  accent?: string;
  /** Makes the screen installable as an app; pair with installRoutes(). */
  install?: InstallOptions;
  /** An image for the orb, e.g. the dot's icon; round art fills it. Default a plain dot. */
  orb?: string;
  /** Colors, for light and dark. Anything left out keeps hev dot's paper and ink. */
  theme?: { light?: Palette; dark?: Palette };
  /** false hides the demo/private switch and always runs private, for a dot with nothing to hide. Default true. */
  modes?: boolean;
  /** The mode a screen starts in until the person picks one (their pick is kept on the device and wins). Default "demo".
   *  The server still refuses private mode to anyone not allowed; the screen then drops back to demo. */
  defaultMode?: "demo" | "private";
  /** Play spoken cues from the dot's `<base>/cue` (see cueRoutes). Default false. */
  cues?: boolean;
  /** The dot's own look, past colors. Trusted strings from the dot's author, never from a user. */
  design?: {
    /** Extra tags for <head>, e.g. a Google Fonts link. */
    head?: string;
    /** CSS after the screen's own, so it wins. */
    css?: string;
    /** HTML drawn behind everything in the app (art, petals, a pattern); it never takes taps. */
    decor?: string;
    /** Trusted JS run after the screen's own. It can listen for the screen's events on window:
     *  dot:ready, dot:greet, dot:tool {name}, dot:done {name, error}, dot:card {card}, dot:error, dot:bye. */
    script?: string;
  };
  /** Sent to the model, as a note from the app, when a fresh session is ready (not on a reconnect), e.g. "Open with a haiku". */
  greeting?: string;
  /** Named views mounted over the chat in the same page; the session carries on underneath. Open one from the
   *  `open_app` tool (appTools), a card's `app`, or `window.dotApps.open(name)`; back, the pill or a voice
   *  close ends it. Trusted strings from the dot's author. */
  apps?: Record<string, AppDef>;
  /** The running build (gitVersion in /version). Info's Build row shows short sha · date (or semver · date when the
   *  version has one) and copies the release and full commit on tap. Its title and the log keep the short sha. */
  version?: Version;
  /** The dot's own earcons: notes as [hz, seconds], with an oscillator type, gain and gap. */
  sounds?: Partial<Record<"tick" | "working" | "card" | "link" | "error", Sound>>;
};

/** An app is HTML and/or JS the dot owns. The screen gives it a container and `dot:*` events. */
export type AppDef = {
  /** Shown in the app's accessible name. */
  title: string;
  /** Markup put in the container when it opens. */
  html?: string;
  /** CSS for the app, added to the page. Scope it to `[data-app="name"]`. */
  css?: string;
  /** A function body, called with (el, api) on open; may return a cleanup function. */
  script?: string;
  /** A URL to an ES module whose `mount(el, api)` runs on open; may return a cleanup function. */
  module?: string;
};

export type Sound = { notes: [number, number][]; type?: "sine" | "triangle" | "square" | "sawtooth"; gain?: number; gap?: number };

/** The screen's colors. `accent` is the dot's signal: the cursor, the glow, links. `second` marks the tool chips and private mode. */
export type Palette = Partial<Record<"paper" | "ink" | "muted" | "rule" | "card" | "accent" | "second", string>>;

const COLOR = /^#[0-9a-f]{3,8}$/i;
function vars(p: Palette = {}): string {
  return Object.entries(p)
    .filter(([, v]) => COLOR.test(v))
    .map(([k, v]) => `--${k === "accent" ? "sig" : k}:${v}`)
    .join(";");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page, as a string. */
export function screen(o: ScreenOptions): string {
  const cfg = {
    name: o.name,
    user: o.user ?? "the user",
    labels: Object.assign({}, ...(o.packs ?? []).map((p) => p.labels ?? {}), o.labels),
    base: o.base ?? "/api",
    modes: o.modes !== false,
    cues: !!o.cues,
    defaultMode: o.defaultMode === "private" ? "private" : "demo",
    greeting: o.greeting ?? null,
    sounds: o.sounds ?? {},
    apps: Object.fromEntries(Object.entries(o.apps ?? {}).map(([k, a]) => [k, { title: a.title, html: a.html, script: a.script, module: a.module }])),
    version: o.version ? { commit: o.version.commit, short: o.version.short, built: o.version.built, ...(semver(o.version.semver) ? { semver: o.version.semver } : {}) } : null,
  };
  // JSON inside <script> must not close the tag.
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const accent = o.accent ?? "#e25822";
  const wm = o.wordmark ? `${esc(o.wordmark[0])}<span class="cur mid"></span>${esc(o.wordmark[1])}` : `${esc(o.name)}<span class="cur"></span>`;
  const v = o.version;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${o.install ? installHead(o.install) : ""}
<title>${esc(o.name)}</title>
${o.design?.head ?? ""}
<style>${CSS.replace("__ACCENT__", accent)}${theme(o.theme)}${Object.values(o.apps ?? {}).map((a) => a.css ?? "").join("")}${o.design?.css ?? ""}</style>
</head>
<body>
<div class="app">
${o.design?.decor ? `<div id="decor" aria-hidden="true">${o.design.decor}</div>` : ""}
  <header><button id="threadsBtn" class="ic" aria-label="threads" aria-haspopup="dialog" aria-controls="threads" title="your threads">☰</button><div class="wm">${wm}${o.subtitle ? `<span class="sfx">${esc(o.subtitle)}</span>` : ""}</div>
    <button id="install" hidden>install</button><button id="mode" class="ic"></button><button id="infoBtn" class="ic" aria-label="info" title="info">i</button></header>
  <main>
    <button id="dot" aria-label="Start voice"><span id="halo"></span>${o.orb ? `<img id="core" class="art" src="${esc(o.orb)}" alt="">` : `<span id="core"></span>`}</button>
    <div id="status" role="status">Ready to chat</div>
    <section id="conversation" role="log" aria-label="Conversation" aria-live="polite"></section>
    <div id="you"></div><div id="say"></div>
    <div id="chips"></div><div id="links"></div>
  </main>
  <footer><label id="modelLabel" hidden>Model <select id="model" aria-label="Model"></select></label><div id="pending"></div><div class="row"><button id="attach" aria-label="add a photo" title="add a photo">📷</button><input id="photo" type="file" accept="image/*" multiple hidden><textarea id="type" aria-label="Message" placeholder="Message" rows="2"></textarea><button id="send" aria-label="Send message">Send</button></div></footer>
  <section id="log"><div class="bar"><span id="logStats"></span><button id="copyLog">copy</button><button id="logClose">close</button></div><div id="list"></div></section>
  <section id="info"><div class="bar"><span>${esc(o.name)}</span><button id="infoClose">close</button></div><div id="infoBody"><button id="logBtn" class="row"><b>log</b><i>this session's turns and tool calls</i></button><div id="about"></div>${v ? `<h3>Build</h3><button id="ver" class="row" title="${esc(v.short)} · copy the build" data-sha="${esc(v.short)}">${esc(semver(v.semver) ? v.semver! : v.short)} · ${esc(v.built.slice(0, 10))}</button>` : ""}</div></section>
  <div id="scrim"></div>
  <section id="threads" role="dialog" aria-modal="true" aria-label="threads" inert><div class="bar"><span>threads</span><button id="newThread">new thread</button><button id="threadsClose" aria-label="close threads">close</button></div><div id="threadList"></div></section>
  <section id="apps" aria-label="app"></section>
  <button id="pill" aria-label="back to chat" hidden><i id="pillDot"></i><span id="pillText"></span></button>
  <div id="toast"></div>
</div>
<script>const CFG=${json};
${SCRIPT}${o.design?.script ? `\n;(()=>{${o.design.script}\n})();` : ""}</script>
</body>
</html>`;
}

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const semver = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && SEMVER.test(s);

function theme(t: ScreenOptions["theme"]): string {
  if (!t) return "";
  const light = vars(t.light), dark = vars(t.dark);
  return (light ? `:root{${light}}` : "") + (dark ? `@media (prefers-color-scheme:dark){:root{${dark}}}` : "");
}

/** Serves the screen at "/" (and "/index.html"); null for anything else, so it chains. */
export function screenRoutes(o: ScreenOptions) {
  const body = screen(o);
  return (req: Request): Response | null => {
    const p = new URL(req.url).pathname;
    if (req.method !== "GET" || (p !== "/" && p !== "/index.html")) return null;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  };
}

const CSS = `
:root{--paper:#fafaf5;--ink:#111;--muted:#6b6b66;--rule:#e8e5dc;--card:#fff;--sig:__ACCENT__;
  --mono:ui-monospace,"JetBrains Mono",Menlo,monospace;--sans:Inter,-apple-system,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#141413;--ink:#f2f0ea;--muted:#9a978e;--rule:#2c2b28;--card:#1d1c1a}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--paper);color:var(--ink);font-family:var(--sans);overscroll-behavior:none}
body{display:flex;justify-content:center}
button{font:inherit;color:inherit;background:none;border:1px solid var(--rule);border-radius:99px;padding:4px 10px;font-size:13px;cursor:pointer}
.app{width:100%;max-width:430px;height:100dvh;display:flex;flex-direction:column;position:relative;overflow:hidden}
header{display:flex;align-items:center;gap:6px;padding:max(10px,env(safe-area-inset-top)) 12px 6px}
header>button{flex:none;min-height:40px}
header .ic{width:40px;height:40px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.wm{font:700 19px var(--mono);margin-right:auto;display:flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap}
.wm .cur{display:inline-block;width:.5em;height:1em;background:var(--sig);margin-left:.16em;animation:blink 1.2s steps(2) infinite}
.wm .cur.mid{margin-right:.16em}
#threadsBtn{font-size:17px;line-height:1;border:0}
#infoBtn{font:italic 600 16px Georgia,serif}
#mode svg{display:block}
.wm .cur{flex:none}.wm .sfx{color:var(--muted);font-weight:500;margin-left:.4em;overflow:hidden;text-overflow:ellipsis}
@keyframes blink{50%{opacity:0}}
#mode.priv{border-color:var(--second,var(--sig));color:var(--second,var(--sig))}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:0 16px;min-height:0}
#dot{position:relative;width:150px;height:150px;border:0;padding:0;border-radius:50%;background:none}
#halo{position:absolute;inset:0;border-radius:50%;background:var(--sig);opacity:.14;transition:transform .08s}
#core{position:absolute;inset:30px;border-radius:50%;background:var(--ink);transition:transform .08s,background .2s}
#dot.on #core{background:var(--sig)}
#dot.connecting #core{animation:pulse 1s ease-in-out infinite}
#core.art{width:90px;height:90px;object-fit:cover;background:var(--card);box-shadow:0 0 18px 2px color-mix(in srgb,var(--sig) 35%,transparent)}
#dot.on #core.art{background:var(--card);box-shadow:0 0 30px 8px color-mix(in srgb,var(--sig) 70%,transparent)}
@keyframes pulse{50%{opacity:.4}}
#status{font:500 13px var(--mono);color:var(--muted)}
#you{color:var(--muted);font-size:15px;text-align:center;min-height:1.2em}
#you .ph,.m .ph{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}#you .ph{justify-content:center}
#you .ph img,.m .ph img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--rule);display:block;margin:0}
#say{font-size:19px;line-height:1.35;text-align:center;max-height:30dvh;overflow:auto}
#chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.chip{font:500 12px var(--mono);border:1px solid var(--second,var(--rule));border-radius:99px;padding:3px 9px;color:var(--second,var(--muted))}
.chip.err{color:#c0392b}
#links{display:flex;flex-direction:column;gap:6px;width:100%}
#links a{display:flex;justify-content:space-between;padding:10px 12px;border:1px solid var(--rule);border-radius:12px;background:var(--card);color:var(--ink);text-decoration:none}
#links a i{color:var(--muted);font-style:normal}
.card{border:1px solid var(--rule);border-radius:14px;background:var(--card);overflow:hidden}
.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--rule)}
.card .body{white-space:pre-line;margin-top:6px;font-size:15px;line-height:1.5}.card .ct{padding:10px 12px}.card b{display:block;font-size:16px}.card .sub{color:var(--muted);font-size:13px;margin-top:2px}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:8px 0 0;font-size:13px}.card dt{color:var(--muted)}.card dd{margin:0}
#links .card a.go{display:block;border:0;border-top:1px solid var(--rule);border-radius:0;padding:9px 12px;color:var(--sig);font-weight:600;text-align:center}
footer{padding:8px 16px max(14px,env(safe-area-inset-bottom))}
footer .row{display:flex;gap:8px;align-items:center}
#attach{flex:none;width:44px;height:44px;padding:0;font-size:19px;border-radius:50%;background:var(--card)}
#pending{display:flex;gap:6px;margin-bottom:6px}#pending:empty{display:none}
#pending span{position:relative}#pending img{width:52px;height:52px;object-fit:cover;border-radius:10px;border:1px solid var(--rule);display:block}
#pending b{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:var(--ink);color:var(--paper);font:700 12px/20px var(--sans);text-align:center;cursor:pointer}
.m img{max-width:120px;max-height:120px;border-radius:8px;display:block;margin-top:4px}
#type{width:100%;font:inherit;font-size:16px;padding:11px 14px;border-radius:99px;border:1px solid var(--rule);background:var(--card);color:var(--ink)}
#log,#info{position:absolute;inset:0;background:var(--paper);display:none;flex-direction:column}
#log.on,#info.on{display:flex}
#info .bar span{margin-right:auto;font:700 15px var(--mono)}
#infoBody{flex:1;overflow:auto;padding:0 16px 16px;font-size:14px}
#infoBody .row{display:flex;align-items:baseline;gap:8px;width:100%;min-height:44px;text-align:left;border-radius:12px;padding:10px 12px;background:var(--card);font-size:14px}
#infoBody .row i{font:12px var(--mono);color:var(--muted);font-style:normal}
#ver{font:13px var(--mono)}
#infoBody h3,#about h3{font:600 12px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px}
#about .tl{padding:7px 0;border-bottom:1px solid var(--rule)}#about .tl b{font-weight:600}#about .tl i{font:11px var(--mono);color:var(--sig);font-style:normal;margin-left:6px}
#about .tl div{color:var(--muted);font-size:13px;margin-top:2px}#about a{color:var(--sig)}
#log .bar,#info .bar{display:flex;gap:8px;align-items:center;padding:max(14px,env(safe-area-inset-top)) 16px 8px}
#logStats{margin-right:auto;font:500 12px var(--mono);color:var(--muted)}
#list{flex:1;overflow:auto;padding:0 16px 16px;font-size:14px}
.m{padding:6px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.m.u{color:var(--muted)}.m.t{font:12px var(--mono);color:var(--muted)}
.m.tool{font:12px var(--mono);cursor:pointer}.m.tool.err b{color:#c0392b}
.m.tool pre{display:none;white-space:pre-wrap;margin:6px 0 0}.m.tool.open pre{display:block}
.m.tool .ms{float:right;color:var(--muted)}
#toast{position:absolute;left:16px;right:16px;bottom:90px;padding:10px 14px;border-radius:12px;background:var(--ink);color:var(--paper);font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.on{opacity:1}
#decor{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0}
header,main,footer{position:relative;z-index:1}
#info{z-index:2}#log{z-index:3}#toast{z-index:7}
#scrim{position:absolute;inset:0;z-index:6;background:#0005;opacity:0;pointer-events:none;transition:opacity .2s}#scrim.on{opacity:1;pointer-events:auto}
#threads{position:absolute;z-index:6;top:0;bottom:0;left:0;width:min(86%,360px);background:var(--paper);border-right:1px solid var(--rule);display:flex;flex-direction:column;transform:translateX(-102%);transition:transform .2s;visibility:hidden}
#threads.on{transform:none;visibility:visible}
#threads .bar{display:flex;gap:8px;align-items:center;padding:max(14px,env(safe-area-inset-top)) 12px 8px 16px}#threads .bar span{margin-right:auto;font:700 15px var(--mono)}
#threadList{flex:1;overflow:auto;padding:0 8px max(14px,env(safe-area-inset-bottom));font-size:14px;color:var(--muted)}
#threadList .th{display:block;width:100%;text-align:left;border:0;border-radius:10px;padding:10px 8px;color:var(--ink)}
#threadList .th:hover,#threadList .th:focus-visible{background:var(--card)}#threadList .th.cur{background:var(--card)}
#threadList .th span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#threadList .th i{font:11px var(--mono);color:var(--muted);font-style:normal}
#apps{position:absolute;inset:0;z-index:3;background:var(--paper);display:none;flex-direction:column}
#apps.on{display:flex}
.app-view{flex:1;min-height:0;overflow:auto;padding:max(54px,calc(env(safe-area-inset-top) + 40px)) 16px 20px}
#pill{position:absolute;z-index:5;top:max(10px,env(safe-area-inset-top));right:12px;display:flex;align-items:center;gap:7px;background:var(--card);padding:5px 12px 5px 8px}
#pill[hidden]{display:none}
#pillDot{width:14px;height:14px;border-radius:50%;background:var(--ink);transition:background .2s,transform .08s}
#pill.on #pillDot{background:var(--sig);box-shadow:0 0 8px 2px color-mix(in srgb,var(--sig) 60%,transparent)}
#pill.connecting #pillDot{animation:pulse 1s ease-in-out infinite}
#pillText{font:500 12px var(--mono);color:var(--muted);max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.app{max-width:960px}
main{justify-content:flex-start;align-items:stretch;gap:8px;padding-top:8px}
#dot{width:44px;height:44px;align-self:flex-end;flex:none}
#core{inset:12px}#core.art{inset:0;width:44px;height:44px}
#conversation{flex:1;min-height:0;overflow:auto;overflow-wrap:anywhere;padding:8px}
#conversation .m{white-space:pre-wrap;padding:12px;border:0;border-radius:12px;margin-bottom:8px;background:var(--card)}
#conversation .u{margin-left:12%;color:var(--ink)}
#conversation .d{margin-right:12%}
#you,#say{display:none}
#type{resize:vertical;min-height:64px;max-height:30dvh;border-radius:12px;min-width:0}
#send,select{min-height:44px}#modelLabel{font-size:13px}
button:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--sig);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// Plain browser JS. CFG comes from the server. Kept in step with hev dot's
// web/index.html for the audio and Live session plumbing.
const SCRIPT = String.raw`
${APPS}
const $=s=>document.querySelector(s), API=CFG.base;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const keep=(k,v)=>{try{if(v===undefined)return localStorage[k];localStorage[k]=v;}catch{}};
const label=n=>CFG.labels[n]||n.replace(/_/g,' ');
function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('on'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('on'),3500); }
let ws=null, ready=false, handle=null, wantMic=true, micOpen=false, sayText='', youText='', wake=null, busy=0, gen=0;

/* demo vs private: the person's pick, else the dot's defaultMode. The server refuses private mode to anyone not allowed.
   Typed turns read the mode as they go; a Live session is locked to its token, so a switch starts it again in the new
   mode, without the old one's resumption handle (it would carry private answers into demo). */
let demo=CFG.modes&&(keep('demo')??(CFG.defaultMode==='private'?'0':'1'))!=='0';
if(!CFG.modes) $('#mode').hidden=true;
/* a lock, drawn in currentColor so it themes: shut in private mode, open in demo. The words are its accessible name. */
const LOCK=shut=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="'+(shut?'M8 11V7a4 4 0 0 1 8 0v4':'M8 11V7a4 4 0 0 1 7.7-1.5')+'"/></svg>';
function drawMode(){ const m=$('#mode'), l=demo?'demo mode':'private mode'; m.innerHTML=LOCK(!demo); m.setAttribute('aria-label',l); m.title=l; m.dataset.mode=demo?'demo':'private'; m.classList.toggle('priv',!demo); }
$('#mode').onclick=()=>{ demo=!demo; keep('demo',demo?'1':'0'); drawMode();
  toast(demo?'Demo mode: no amounts or contact details.':'Private mode: full numbers.');
  if(ws){ const mic=wantMic; stop(); handle=null; start({mic,quiet:true}); } };
/* refused private mode (not an allowed login): back to demo for now, without saving it */
function refusedPrivate(){ demo=true; drawMode(); toast('Private mode needs an allowed login. Demo mode.'); }
drawMode();

/* transcript, shipped to /trace every few seconds */
const newSid=()=>(crypto.randomUUID?.()||Date.now().toString(16)+Math.random().toString(16).slice(2)).toLowerCase();
let SID=newSid(), T0=Date.now(), trace=[], unsent=[], seq=0;
function rec(e){ e.id=SID.slice(0,8)+'-'+(++seq); e.ts=new Date().toISOString(); trace.push(e); unsent.push(e); }
const build=CFG.version?(CFG.version.semver?CFG.version.semver+' · ':'')+CFG.version.short:'';
const markStart=()=>{ rec({t:0,kind:'start',...(CFG.version?{build:CFG.version.short,...(CFG.version.semver?{semver:CFG.version.semver}:{})}:{})}); $('#logStats').textContent=build; }; markStart();
function ship(beacon){ if(!unsent.length) return; const body=JSON.stringify({session:SID,events:unsent}); unsent=[];
  if(beacon&&navigator.sendBeacon) navigator.sendBeacon(API+'/trace',new Blob([body],{type:'application/json'}));
  else fetch(API+'/trace',{method:'POST',headers:{'content-type':'application/json'},body,keepalive:true}).catch(()=>{}); }
setInterval(()=>ship(false),4000); addEventListener('pagehide',()=>ship(true));
function show(cls,text){ const d=document.createElement('div'); d.className='m '+cls; d.textContent=text; $('#list').append(d); if(cls==='u'||cls==='d'){ const c=document.createElement('div'); c.className='m '+cls; c.textContent=text; $('#conversation').append(c); $('#conversation').scrollTop=1e9; } $('#list').scrollTop=1e9; return d; }
function log(cls,text,extra){ rec({t:Date.now()-T0,kind:cls,text,...extra}); return show(cls,text); }
/* a user turn, with its photos' thumbnails: in the log line and under the orb */
function thumbs(el,urls){ if(!urls?.length) return; const p=document.createElement('div'); p.className='ph';
  urls.forEach(u=>{ if(!u) return; const im=document.createElement('img'); im.src=u; im.alt='photo'; p.append(im); }); el.append(p); }
function showU(text,urls){ const d=show('u',text); thumbs(d,urls); return d; }
function youSaid(text,urls){ const y=$('#you'); y.textContent=text?'“'+text+'”':''; thumbs(y,urls); }
function logTool(fc,result,ms){ const err=!!result?.error, body=JSON.stringify(result,null,1)||'';
  rec({t:Date.now()-T0,kind:'tool',name:fc.name,args:fc.args||{},ms,bytes:body.length,error:result?.error||null,result});
  const d=document.createElement('div'); d.className='m tool'+(err?' err':'');
  d.innerHTML='<span class="ms">'+ms+' ms</span><b>'+(err?'✗':'⚙')+' '+esc(fc.name)+'</b>('+esc(JSON.stringify(fc.args||{}))+')'+(err?'<br>'+esc(result.error):'')+'<pre>'+esc(body.slice(0,20000))+'</pre>';
  d.onclick=()=>d.classList.toggle('open'); $('#list').append(d);
  const ts=trace.filter(x=>x.kind==='tool'); $('#logStats').textContent=(build?build+' · ':'')+ts.length+' tool calls · '+ts.filter(x=>x.error).length+' errors'; }
/* info: the tools, as the dot sees them, and the inbox it reads */
const KIND={act:'needs a yes',private:'private mode',display:'shows on screen',slow:'sub-agent'};
/* info and the log: panes over the chat. Each open pushes a history entry, so back (and Escape) closes the top one;
   the log opens from inside info, so closing it lands back in info. */
const pane=(id,on)=>{ $(id).classList.toggle('on',on); };
const isOn=id=>$(id).classList.contains('on');
function openLog(){ if(isOn('#log')) return; pane('#log',true); history.pushState({dotLog:1},''); $('#logClose').focus?.(); }
function closeLog(){ if(!isOn('#log')) return; pane('#log',false); $('#logBtn').focus?.(); if(history.state?.dotLog) history.back(); }
function closeInfo(){ if(!isOn('#info')) return; closeLog(); pane('#info',false); $('#infoBtn').focus?.(); if(history.state?.dotInfo) history.back(); }
addEventListener('popstate',()=>{ const s=history.state;
  if(isOn('#log')&&!s?.dotLog){ pane('#log',false); $('#logBtn').focus?.(); }
  if(isOn('#info')&&!s?.dotLog&&!s?.dotInfo){ pane('#info',false); $('#infoBtn').focus?.(); } });
addEventListener('keydown',e=>{ if(e.key!=='Escape') return; if(isOn('#log')) closeLog(); else if(isOn('#info')) closeInfo(); });
$('#infoBtn').onclick=async()=>{ if(isOn('#info')) return; pane('#info',true); history.pushState({dotInfo:1},''); $('#infoClose').focus?.(); const box=$('#about'); box.textContent='…';
  const i=await fetch(API+'/info').then(r=>r.json()).catch(()=>null); if(!i||i.error){ box.textContent='Couldn’t load the tool list.'; return; }
  box.innerHTML=(i.inbox?'<h3>Inbox</h3><div class="tl">Forward mail to <a href="mailto:'+esc(i.inbox)+'">'+esc(i.inbox)+'</a> and your dot can read it.</div>':'')+
    '<h3>Tools · '+i.tools.length+'</h3>'+i.tools.map(t=>'<div class="tl"><b>'+esc(label(t.name))+'</b>'+(KIND[t.kind]?'<i>'+KIND[t.kind]+'</i>':'')+'<div>'+esc(t.description)+'</div></div>').join('')+
    '<h3>Modes</h3><div class="tl">Tap the dot to talk; type to get answers in text.'+(CFG.modes?' '+(demo?'Demo mode hides amounts and contact details.':'Private mode shows real numbers.'):'')+'</div>'+
    (i.version&&!CFG.version?'<h3>Build</h3><div class="tl">'+(i.version.semver?'<b>'+esc(i.version.semver)+'</b> · ':'')+esc(i.version.short)+' · '+esc(String(i.version.built).slice(0,10))+'</div>':''); };
$('#infoClose').onclick=closeInfo; $('#logBtn').onclick=openLog; $('#logClose').onclick=closeLog;
$('#copyLog').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(trace,null,1)).then(()=>toast('Copied as JSON')).catch(()=>toast('Copy blocked'));

/* audio out: 24 kHz PCM16, scheduled back to back */
let outCtx, outAt=0, playing=[], outLevel;
function ensureOut(){ if(outCtx) return; outCtx=new AudioContext({sampleRate:24000}); outLevel=outCtx.createAnalyser(); outLevel.fftSize=256; outLevel.connect(outCtx.destination); }
function play(b64){ ensureOut(); const bin=atob(b64), n=bin.length/2, buf=outCtx.createBuffer(1,n,24000), ch=buf.getChannelData(0);
  for(let i=0;i<n;i++){ let v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8); if(v>=32768) v-=65536; ch[i]=v/32768; }
  const src=outCtx.createBufferSource(); src.buffer=buf; src.connect(outLevel); const t=Math.max(outCtx.currentTime+.03,outAt); src.start(t); outAt=t+buf.duration;
  playing.push(src); src.onended=()=>{ playing=playing.filter(s=>s!==src); }; }
function flush(){ playing.forEach(s=>{ try{s.stop();}catch{} }); playing=[]; outAt=0; }

/* sound: earcons for tool calls, and spoken cues in the dot's voice when the dot serves them */
let sfx; const sfxCtx=()=>sfx||(sfx=new AudioContext());
let voiceEnabled=false;
function tone(notes,{type='sine',gain=.05,gap=0}={}){ if(!voiceEnabled) return; const c=sfxCtx(); c.resume(); let t=c.currentTime+.01;
  for(const [f,d] of notes){ const o=c.createOscillator(), g=c.createGain(); o.type=type; o.frequency.value=f;
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(gain,t+.01); g.gain.exponentialRampToValueAtTime(.0001,t+d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+d+.02); t+=d+gap; } }
const ear={
  tick:()=>tone([[1320,.05]],{gain:.035}),                                // started looking something up
  working:()=>tone([[440,.09]],{type:'triangle',gain:.025}),              // still checking (every 1.6s)
  card:()=>tone([[660,.06],[990,.08]],{gain:.04,gap:.02}),                // something went up on screen
  link:()=>tone([[880,.06],[1320,.08]],{gain:.04,gap:.02}),
  error:()=>tone([[247,.16],[185,.26]],{type:'triangle',gain:.06,gap:.03}),
};
for(const [k,v] of Object.entries(CFG.sounds)) ear[k]=()=>tone(v.notes,v);
const emit=(n,detail)=>dispatchEvent(new CustomEvent('dot:'+n,{detail}));
const speakingNow=()=>lvl(outLevel)>.02;
setInterval(()=>{ if(ws&&busy>0&&!speakingNow()) ear.working(); },1600);
const cueBuf={}, lastTake={};
async function loadCue(kind){ if(!CFG.cues||!voiceEnabled) return; try{ const n=Math.floor(Math.random()*6), r=await fetch(API+'/cue?kind='+kind+'&n='+(n===lastTake[kind]?n+1:n)); if(!r.ok) return;
  lastTake[kind]=n; cueBuf[kind]=await sfxCtx().decodeAudioData(await r.arrayBuffer()); }catch{} }

/* resolves when the cue has finished, so the mic can wait for it and not hear the dot */
function playCue(kind){ const b=cueBuf[kind]; loadCue(kind); if(!b) return Promise.resolve();
  const c=sfxCtx(); c.resume(); const s=c.createBufferSource(); s.buffer=b; s.connect(c.destination); s.start();
  return new Promise(r=>{ s.onended=r; setTimeout(r,(b.duration+.5)*1000); }); }
let wakingCue=Promise.resolve(), quietStart=false, greeted=null;

/* audio in: mic to 16 kHz PCM16, 40 ms chunks */
let inCtx, micStream, inLevel;
const WORKLET='class P extends AudioWorkletProcessor{constructor(){super();this.b=[];}process(i){const c=i[0][0];if(c){for(const s of c)this.b.push(s);while(this.b.length>=640){const f=this.b.splice(0,640),o=new Int16Array(640);for(let k=0;k<640;k++){const v=Math.max(-1,Math.min(1,f[k]));o[k]=v<0?v*32768:v*32767;}this.port.postMessage(o.buffer,[o.buffer]);}}return true;}}registerProcessor("p",P);';
async function startMic(){
  if(!isSecureContext||!navigator.mediaDevices){ toast('Voice needs HTTPS. Type for now.'); return false; }
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
  inCtx=new AudioContext({sampleRate:16000}); await inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET],{type:'text/javascript'})));
  const src=inCtx.createMediaStreamSource(micStream), node=new AudioWorkletNode(inCtx,'p'); inLevel=inCtx.createAnalyser(); inLevel.fftSize=256;
  src.connect(inLevel); src.connect(node);
  node.port.onmessage=e=>{ if(ws?.readyState===1&&ready&&micOpen){ const u=new Uint8Array(e.data); let s=''; for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]);
    ws.send(JSON.stringify({realtimeInput:{audio:{data:btoa(s),mimeType:'audio/pcm;rate=16000'}}})); } };
  return true; }
function stopMic(){ micStream?.getTracks().forEach(t=>t.stop()); inCtx?.close(); micStream=inCtx=inLevel=null; }

/* the dot breathes with whoever is talking */
const lvl=a=>{ if(!a) return 0; const d=new Uint8Array(a.fftSize); a.getByteTimeDomainData(d); let m=0; for(const v of d) m=Math.max(m,Math.abs(v-128)); return m/128; };
const status=t=>$('#status').textContent=t;
(function anim(){ const o=lvl(outLevel), i=lvl(inLevel), speaking=o>.02, hearing=ready&&!speaking&&i>.05;
  if(ws&&ready) status(busy?'checking…':speaking?CFG.name:hearing?'hearing you':micStream?'listening':'typing · tap to talk');
  $('#halo').style.transform='scale('+(1+o*.35+(hearing?Math.min(i,.2):0))+')'; $('#core').style.transform='scale('+(1+o*.06)+')';
  if(document.body.classList.contains('app-open')){ const p=$('#pill'); p.classList.toggle('on',!!(ws&&ready)); p.classList.toggle('connecting',$('#dot').classList.contains('connecting'));
    $('#pillText').textContent=$('#status').textContent; $('#pillDot').style.transform='scale('+(1+o*.5+(hearing?Math.min(i,.3):0))+')'; }
  requestAnimationFrame(anim); })();

function note(text){ ws?.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[{text:'[note from the app, not from '+CFG.user+'] '+text}]}],turnComplete:true}})); }

/* the Live session: the token carries the persona and tools, locked server-side */
async function start({mic=true,quiet=false}={}){ wantMic=mic; micOpen=false;
  const dot=$('#dot'); dot.classList.add('connecting'); status('waking…'); ensureOut(); outCtx.resume();
  quietStart=quiet; wakingCue=quiet||!mic?Promise.resolve():playCue('waking');
  try{
    let res=await fetch(API+'/token?safe='+(demo?1:0));
    if(res.status===403&&!demo){ refusedPrivate(); res=await fetch(API+'/token?safe=1'); }
    const tk=await res.json(); if(tk.error) throw new Error(tk.error);
    const sock=new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token='+encodeURIComponent(tk.token));
    ws=sock;
    ws.onopen=()=>sock.send(JSON.stringify({setup:{model:tk.model,...(handle?{sessionResumption:{handle}}:{})}}));
    ws.onmessage=async ev=>{ if(ws===sock) onMsg(JSON.parse(typeof ev.data==='string'?ev.data:await ev.data.text())); };
    /* an old socket closing late (after a mode switch or a reconnect) must not take the new one with it */
    ws.onclose=e=>{ if(ws&&ws!==sock) return; const was=!!ws; ws=null; ready=false; dot.classList.remove('on','connecting'); stopMic(); wake?.release?.(); wake=null; micOpen=false;
      status(e.code===1000?'tap to talk':'disconnected · tap to reconnect'); if(e.code!==1000&&was){ log('t','session closed '+e.code+(e.reason?' · '+e.reason:'')); ear.error(); emit('error'); playCue('lost'); } };
  }catch(e){ dot.classList.remove('connecting'); status('Ready to chat'); toast('Couldn’t wake '+CFG.name+': '+e.message); ws=null; ear.error(); wakingCue.then(()=>playCue('unreachable')); }
}
function stop({bye=false}={}){ if(ws){ const w=ws; ws=null; w.close(1000); if(bye){ playCue('bye'); emit('bye'); } } micOpen=false; flush(); }
async function onMsg(m){
  if(m.setupComplete){ ready=true; $('#dot').classList.remove('connecting'); $('#dot').classList.add('on');
    wake=await navigator.wakeLock?.request('screen').catch(()=>null);
    const mic=micStream?true:wantMic?await startMic().catch(e=>{ toast('Mic: '+e.message); return false; }):false;
    if(mic&&!quietStart){ await wakingCue; await playCue('ready'); }  // only then open the mic, so it doesn't hear itself
    micOpen=true; if(!mic&&wantMic) status('typing only'); emit('ready');
    if(resumed&&resumed.sid===SID&&!resumed.told){ resumed.told=true; greeted=SID; context(resumed.lines); }
    if(pending.length) photosToLive('');
    else if(CFG.greeting&&greeted!==SID&&!quietStart){ greeted=SID; emit('greet'); note(CFG.greeting); }
    return; }
  if(m.sessionResumptionUpdate?.newHandle) handle=m.sessionResumptionUpdate.newHandle;
  if(m.goAway){ log('t','reconnecting'); playCue('reconnect'); const w=ws; ws=null; w?.close(1000); return start({mic:wantMic,quiet:true}); }
  if(m.toolCall) return tools(m.toolCall.functionCalls||[]);
  const sc=m.serverContent; if(!sc) return;
  if(sc.interrupted){ flush(); finishSay(); }
  if(sc.inputTranscription?.text){ youText+=sc.inputTranscription.text; youSaid(youText.trim()); }
  for(const p of sc.modelTurn?.parts||[]) if(p.inlineData?.data) play(p.inlineData.data);
  if(sc.outputTranscription?.text){ if(youText){ log('u',youText.trim()); youText=''; } sayText+=sc.outputTranscription.text; $('#say').textContent=sayText; }
  if(sc.turnComplete&&sayText) finishSay();
}
function finishSay(){ if(youText){ log('u',youText.trim()); youText=''; } if(sayText.trim()) log('d',sayText.trim()); sayText=''; }

/* display results: a tappable link; the model only hears that it's up */
function showLink(url,text){ let host; try{ host=new URL(url).hostname; }catch{ return; }
  const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.innerHTML='<span>'+esc(text||host)+'</span><i>'+esc(host)+' ↗</i>';
  const box=$('#links'); box.prepend(a); while(box.children.length>3) box.lastChild.remove(); log('t','🔗 '+(text||url),{url}); ear.link(); }

/* display cards: the screen draws it; a tap on the link hands the https URL to the phone, which opens the app */
function showCard(c){ const el=document.createElement('div'); el.className='card'+(/^[a-z0-9-]+$/.test(c.style||'')?' '+c.style:'');
  el.innerHTML=(c.image?'<img src="'+esc(c.image.src)+'" alt="'+esc(c.image.alt)+'">':'')+
    '<div class="ct"><b>'+esc(c.title)+'</b>'+(c.subtitle?'<div class="sub">'+esc(c.subtitle)+'</div>':'')+(c.body?'<div class="body">'+esc(c.body)+'</div>':'')+
    (c.lines?.length?'<dl>'+c.lines.map(l=>'<dt>'+esc(l.k)+'</dt><dd>'+esc(l.v)+'</dd>').join('')+'</dl>':'')+'</div>'+
    (c.app&&CFG.apps[c.app.name]?'<a class="go" href="#app/'+esc(c.app.name)+'" data-app="'+esc(c.app.name)+'">'+esc(c.app.label)+'</a>':'')+
    (c.link&&/^https:/.test(c.link.url)?'<a class="go" href="'+esc(c.link.url)+'" target="_blank" rel="noopener">'+esc(c.link.label)+' ↗</a>':'');
  const box=$('#links'); box.prepend(el); while(box.children.length>3) box.lastChild.remove(); log('t','🗂 '+c.title,{card:c}); ear.card(); emit('card',{card:c}); }

async function call(fc){ const r=await fetch(API+'/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:fc.name,args:fc.args||{},safe:demo,session:SID})}); return r.json(); }
async function tools(calls){ const g=gen;
  const responses=await Promise.all(calls.map(async fc=>{
    const chip=document.createElement('span'); chip.className='chip'; chip.textContent='⟳ '+label(fc.name); $('#chips').append(chip);
    busy++; ear.tick(); emit('tool',{name:fc.name}); const t0=performance.now(); let result;
    try{ result=await call(fc); }catch(e){ result={error:String(e)}; }
    if(g!==gen) return null; busy--; logTool(fc,result,Math.round(performance.now()-t0));
    if(result?.job){ awaitJob(fc,result.job); result={working:true,note:'This takes a while. The answer will come back by itself; say so and carry on.'}; }
    else if(result?.card&&!result.error){ showCard(result.card); result={shown:true,...(result.card.note?{note:result.card.note}:{})}; }
    else if(result?.url&&result.label&&!result.error){ showLink(result.url,result.label); result={shown:true}; }
    else if(result?.app&&!result.error){ const ok=openApp(result.app); result=ok?{shown:true,...(result.note?{note:result.note}:{})}:{error:'no app called '+result.app}; }
    else if(result?.close_app&&!result.error){ closeApp(); result={shown:true}; }
    if(result?.error) ear.error(); emit('done',{name:fc.name,error:!!result?.error});
    chip.className='chip'+(result?.error?' err':''); chip.textContent=(result?.error?'✗ ':'✓ ')+label(fc.name); setTimeout(()=>chip.remove(),6000);
    return {id:fc.id,name:fc.name,response:{result}}; }));
  if(g===gen) ws?.send(JSON.stringify({toolResponse:{functionResponses:responses}})); }

/* slow tools: poll the job, then hand the result back to relay */
function awaitJob(fc,id){ const t0=Date.now(), g=gen; busy++;
  const tick=async()=>{ if(g!==gen) return; const r=await (await fetch(API+'/job/'+id)).json().catch(()=>({})); if(g!==gen) return;
    if(r.status!=='done'&&!r.error&&Date.now()-t0<1800000) return setTimeout(tick,3000);
    busy--; logTool({name:fc.name+' (done)',args:fc.args},r.result??r,Date.now()-t0);
    const msg='The result of '+fc.name+' is back. Tell '+CFG.user+' what it says:\n'+JSON.stringify(r.result??r);
    if(ws&&ready) note(msg); else toast(label(fc.name)+' is ready. Open the log.'); };
  setTimeout(tick,3000); }

const goFull=()=>{ if(!document.fullscreenElement&&!matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) document.documentElement.requestFullscreen?.({navigationUI:'hide'}).catch(()=>{}); };
$('#dot').onclick=async()=>{ voiceEnabled=true; if(ws&&ready&&!micStream){ wantMic=true; await startMic().catch(e=>{ toast('Mic: '+e.message); }); }
  else if(ws){ stop({bye:true}); status('Ready to chat'); } else { goFull(); $('#you').textContent=''; $('#say').textContent=''; start(); } };
/* text mode: a typed question gets a typed answer, from the server's chat loop.
   Voice stops, so nothing talks over the page. The server traces these turns itself. */

async function ask(t){ if(ws){ stop(); } voiceEnabled=false; const g=gen;
  const ps=pending; pending=[]; drawPending();
  const urls=ps.map(p=>p.thumb); showU(t,urls); youSaid(t,urls); $('#say').textContent='…'; status('thinking…');
  let res; try{ res=await fetch(API+'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t,session:SID,safe:demo,...(selectedModel?{model:selectedModel}:{}),...(ps.length?{images:ps.map(p=>({mimeType:p.mimeType,data:p.data,thumb:p.thumb}))}:{})})}); }
  catch(e){ throw new Error('Couldn’t reach '+CFG.name+': '+e.message); }
  if(res.status===403&&!demo){ refusedPrivate(); pending=ps.concat(pending); drawPending(); $('#list').lastChild?.remove(); return ask(t); }
  if(!res.ok){ pending=ps.concat(pending); drawPending(); throw new Error(res.status===404?'Text chat is unavailable. Voice is available only with Start voice.':'Chat failed ('+res.status+'). Try again.'); }
  const rd=res.body.getReader(), dec=new TextDecoder(); let buf='', chips=[];
  for(;;){ const {value,done}=await rd.read(); if(g!==gen) return true; if(done) break; buf+=dec.decode(value,{stream:true});
    let i; while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim()) continue; const m=JSON.parse(line);
      if(m.slow){ status('asking a sub-agent…'); const c=document.createElement('span'); c.className='chip'; c.textContent='⟳ '+label(m.slow); $('#chips').append(c); chips.push(c); }
      if(m.display){ if(m.display.card) showCard(m.display.card); else if(m.display.url) showLink(m.display.url,m.display.label); else if(m.display.app) openApp(m.display.app); else if(m.display.close_app) closeApp(); }
      if(m.error){ $('#say').textContent=''; show('t','✗ '+m.error); toast(m.error); }
      if(m.reply){ $('#say').textContent=m.reply; show('d',m.reply); } } }
  chips.forEach(c=>c.remove()); status('Ready to chat'); return true; }

/* photos: from the camera roll or the camera, shrunk on the phone, then sent to the voice session or with the next typed turn */
let pending=[];
async function shrink(file){ const img=await new Promise((ok,no)=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>no(new Error('can’t read that photo')); i.src=URL.createObjectURL(file); });
  const k=Math.min(1,1280/Math.max(img.naturalWidth,img.naturalHeight)), c=document.createElement('canvas'); c.width=Math.round(img.naturalWidth*k); c.height=Math.round(img.naturalHeight*k);
  c.getContext('2d').drawImage(img,0,0,c.width,c.height); const url=c.toDataURL('image/jpeg',.85);
  const q=Math.min(1,192/Math.max(img.naturalWidth,img.naturalHeight)), s=document.createElement('canvas'); s.width=Math.round(img.naturalWidth*q); s.height=Math.round(img.naturalHeight*q);
  s.getContext('2d').drawImage(img,0,0,s.width,s.height); URL.revokeObjectURL(img.src);
  return {mimeType:'image/jpeg',data:url.split(',')[1],url,thumb:s.toDataURL('image/jpeg',.7)}; }
function drawPending(){ const box=$('#pending'); box.textContent='';
  pending.forEach((p,i)=>{ const s=document.createElement('span'); s.innerHTML='<img alt="photo to send"><b aria-label="remove">×</b>'; s.querySelector('img').src=p.url;
    s.querySelector('b').onclick=()=>{ pending.splice(i,1); drawPending(); }; box.append(s); }); }
/* a voice turn's photos: traced with their thumbnails (the server keeps them in the thread), drawn in the log and under the orb */
function logPhotos(ps,text){ const urls=ps.map(p=>p.thumb); rec({t:Date.now()-T0,kind:'u',text,photos:urls}); showU(text,urls); youSaid(text,urls); }
/* to the Live session: the photos inline in one turn with what to do with them
   (a realtimeInput video frame isn't seen by a typed turn; checked against Gemini Live) */
function photosToLive(text){ const ps=pending; pending=[]; drawPending(); if(!ps.length) return;
  logPhotos(ps,text); emit('photo',{count:ps.length});
  ws.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[...ps.map(p=>({inlineData:{mimeType:p.mimeType,data:p.data}})),{text:text||'[note from the app, not from '+CFG.user+'] '+CFG.user+' just shared '+(ps.length>1?ps.length+' photos':'a photo')+'. Say in a sentence what you see, then ask what she’d like to do with it.'}]}],turnComplete:true}})); }
$('#attach').onclick=()=>$('#photo').click();
$('#photo').onchange=async e=>{ const files=[...e.target.files].slice(0,4-pending.length); e.target.value='';
  for(const f of files){ try{ pending.push(await shrink(f)); }catch(err){ toast(err.message); } }
  drawPending(); if(ws&&ready&&pending.length) photosToLive($('#type').value.trim()||''); };

/* switching session: the old one's trace ships; everything on screen and in the Live session goes */
function reset(sid){ ship(false); gen++; busy=0; stop(); handle=null; apps.close(); resumed=null;
  SID=sid||newSid(); T0=Date.now(); trace=[]; seq=0;
  for(const s of ['#conversation','#list','#links','#chips','#you','#say','#logStats']) $(s).textContent='';
  markStart(); closeLog(); status('Ready to chat'); }
function fresh(){ log('t','cleared'); reset(); toast('Fresh start.'); }

/* threads: this user's past sessions, kept by the server. A tap resumes one: its transcript comes back, the session id
   carries on (so typed turns keep their history), and a Live session started in it gets the last lines as context. */
let resumed=null, thOpen=false, thFrom=null;
const ago=ms=>{ const s=(Date.now()-ms)/1000; return s<60?'just now':s<3600?Math.round(s/60)+' min ago':s<86400?Math.round(s/3600)+' h ago':s<604800?Math.round(s/86400)+' d ago':new Date(ms).toLocaleDateString(); };
function drawer(on){ thOpen=on; $('#threads').classList.toggle('on',on); $('#scrim').classList.toggle('on',on); $('#threads').inert=!on;
  document.querySelectorAll('.app>header,.app>main,.app>footer').forEach(e=>{ e.inert=on; }); }
async function openThreads(){ if(thOpen) return; thFrom=document.activeElement; drawer(true); history.pushState({dotThreads:1},''); $('#newThread').focus?.();
  const box=$('#threadList'); box.textContent='…';
  const r=await fetch(API+'/threads?safe='+(demo?1:0)).then(x=>x.json()).catch(()=>null); if(!thOpen) return;
  if(!r||r.error){ box.textContent=r?.error==='threads need a login'?'Threads need a login.':'Couldn’t load your threads.'; return; }
  box.textContent=r.threads.length?'':'No past threads yet.';
  for(const t of r.threads){ const b=document.createElement('button'); b.className='th'+(t.id===SID?' cur':''); b.dataset.id=t.id;
    b.innerHTML='<span>'+esc(t.first)+'</span><i>'+(t.id===SID?'this thread · ':'')+esc(ago(t.at))+'</i>';
    b.onclick=()=>{ closeThreads(); resume(t.id); }; box.append(b); } }
function closeThreads(){ if(!thOpen) return; drawer(false); thFrom?.focus?.(); if(history.state?.dotThreads) history.back(); }
addEventListener('popstate',()=>{ if(thOpen&&!history.state?.dotThreads){ drawer(false); thFrom?.focus?.(); } });  /* back, swipe-back */
addEventListener('keydown',e=>{ if(e.key==='Escape'&&thOpen) closeThreads(); });
let swipeX=null; $('#threads').addEventListener('touchstart',e=>{ swipeX=e.touches[0].clientX; },{passive:true});
$('#threads').addEventListener('touchend',e=>{ if(swipeX!==null&&swipeX-e.changedTouches[0].clientX>60) closeThreads(); swipeX=null; });
$('#threadsBtn').onclick=openThreads; $('#threadsClose').onclick=closeThreads; $('#scrim').onclick=closeThreads;
$('#newThread').onclick=()=>{ closeThreads(); fresh(); };
async function resume(id){ if(id===SID) return;
  const r=await fetch(API+'/threads/'+id+'?safe='+(demo?1:0)).then(x=>x.json()).catch(()=>null); if(!r||r.error||!Array.isArray(r.lines)){ toast('Couldn’t open that thread.'); return; }
  reset(id); resumed={sid:id,lines:r.lines,told:false};
  for(const l of r.lines){ if(l.k==='u') showU(l.text,l.photos); else show(l.k==='d'?'d':'t',l.text); }
  const u=r.lines.filter(l=>l.k==='u').at(-1), d=r.lines.filter(l=>l.k==='d').at(-1);
  if(u) youSaid(u.text,u.photos); if(d) $('#say').textContent=d.text; toast('Back in that thread.'); }
/* the resumed thread's last lines, into the Live context without asking for a reply */
function context(lines){ const said=lines.filter(l=>l.k!=='t').slice(-12).map(l=>(l.k==='u'?CFG.user:'You')+': '+(l.photos?.length?'[photo] ':'')+l.text.slice(0,300)).join('\n');
  if(said) ws?.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[{text:'[note from the app, not from '+CFG.user+'] This picks up an earlier conversation. It went:\n'+said}]}],turnComplete:false}})); }
let selectedModel='', sending=false;
fetch(API+'/info').then(r=>{if(!r.ok) throw new Error(); return r.json();}).then(i=>{
  const models=Array.isArray(i.models)?i.models:[];
  for(const m of models){ const o=document.createElement('option'); o.value=m.id; o.textContent=m.name; $('#model').append(o); }
  $('#modelLabel').hidden=models.length<2;
  if(models.length) selectedModel=models[0].id;
}).catch(()=>{});
$('#model').onchange=e=>{ selectedModel=e.target.value; };
async function submit(){
  const input=$('#type'), t=input.value.trim(); if(sending||(!t&&!pending.length)) return;
  if(/^\/(clear|new)$/i.test(t)){ input.value=''; return fresh(); }
  sending=true; $('#send').disabled=true; input.value='';
  try{ await ask(t); }catch(e){ input.value=t; status('Couldn’t send message'); toast(e.message); }
  finally{ sending=false; $('#send').disabled=false; input.focus?.(); }
}
$('#send').onclick=submit;
$('#type').onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault?.(); return submit(); } };

/* apps: views over the chat. The page underneath keeps running; the pill below is the orb, shrunk. */
const inert=on=>document.querySelectorAll('.app>header,.app>main,.app>footer').forEach(e=>{ e.inert=on; });
const apps=createApps({doc:document,win:window,hist:history,host:$('#apps'),defs:CFG.apps,
  onChange(name){ document.body.classList.toggle('app-open',!!name); $('#pill').hidden=!name; inert(!!name);
    if(name){ $('#apps').setAttribute('aria-label',CFG.apps[name].title); log('t','▣ '+CFG.apps[name].title+' opened',{app:name}); } else $('#apps').removeAttribute('aria-label');
    emit('app',{name}); },
  onError(name,e){ log('t','✗ app '+name+': '+e); toast('That app didn’t open.'); ear.error(); }});
const openApp=n=>{ if(!apps.open(n)){ toast('No app called '+n+'.'); return false; } return true; };
const closeApp=()=>apps.close();
window.dotApps={open:openApp,close:closeApp,current:apps.current};
$('#pill').onclick=closeApp;
$('#links').addEventListener('click',e=>{ const a=e.target.closest?.('[data-app]'); if(a){ e.preventDefault(); openApp(a.dataset.app); } });
if(CFG.version) $('#ver').onclick=()=>navigator.clipboard?.writeText((CFG.version.semver?CFG.version.semver+' ':'')+CFG.version.commit).then(()=>toast('Copied '+build)).catch(()=>toast('Copy blocked'));

/* installable: the worker comes from installRoutes() */
let installEv=null;
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); installEv=e; $('#install').hidden=false; });
addEventListener('appinstalled',()=>{ installEv=null; $('#install').hidden=true; });
$('#install').onclick=async()=>{ if(!installEv) return; installEv.prompt(); await installEv.userChoice; installEv=null; $('#install').hidden=true; };
`;
