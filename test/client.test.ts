import assert from "node:assert/strict";
import { test } from "node:test";
import { screen, screenRoutes } from "../src/client/index.ts";

const icons = { any192: "/icon-192.png", any512: "/icon.png", maskable512: "/icon-maskable.png" };

test("the screen carries the dot's name, labels and install tags", () => {
  const html = screen({ name: "me", subtitle: "finance", labels: { spend: "your spending" }, install: { name: "me", color: "#fafaf5", icons } });
  assert.match(html, /<title>me<\/title>/);
  assert.match(html, /"spend":"your spending"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /\/api\/token|API\+'\/token/);
});

test("the screen can start a fresh session, from the threads drawer or /clear", () => {
  const html = screen({ name: "me" });
  assert.match(html, /<button id="threadsBtn"[^>]*aria-controls="threads"/);
  assert.match(html, /id="newThread"/);
  assert.doesNotMatch(html, /id="new"/, "the old chip is gone");
  assert.match(html, /\(clear\|new\)/);
});

test("config can't close the script tag", () => {
  const html = screen({ name: "x", labels: { a: "</script><script>alert(1)" } });
  assert.equal(html.split("</script>").length, 2);
});

test("the page script parses", () => {
  const html = screen({ name: "x" });
  const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(js));
});

test("routes serve the page at / and pass everything else on", async () => {
  const route = screenRoutes({ name: "me" });
  const r = route(new Request("https://me.example/"))!;
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await r.text(), /<title>me<\/title>/);
  assert.equal(route(new Request("https://me.example/api/token")), null);
  assert.equal(route(new Request("https://me.example/", { method: "POST" })), null);
});

test("the orb can be the dot's own art", () => {
  assert.match(screen({ name: "me", orb: "/icon.png" }), /<img id="core" class="art" src="\/icon.png"/);
  assert.match(screen({ name: "me" }), /<span id="core">/);
});

test("a theme sets the colors, light and dark, and only real colors get in", () => {
  const html = screen({ name: "me", theme: { light: { paper: "#f4e5c6", accent: "#8b5a2b", second: "#6b7340" }, dark: { ink: "#f2e6cc", card: "red;}</style>" } } });
  assert.match(html, /:root\{--paper:#f4e5c6;--sig:#8b5a2b;--second:#6b7340\}/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root\{--ink:#f2e6cc\}\}/);
  assert.doesNotMatch(html, /red;\}/);
});

// The page, run in a small fake browser: the real script, real createApps, a
// Live session that is up (ws open), a transcript line and a pending job.
import vm from "node:vm";
function boot(opts: Parameters<typeof screen>[0], env: Record<string, unknown> = {}) {
  const html = screen(opts);
  const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const els = new Map<string, any>();
  const mk = (id = ""): any => {
    const cls = new Set<string>();
    const e: any = {
      id, children: [], style: {}, dataset: {}, attrs: {}, text: "", hidden: false, inert: false, classList: {
        add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c),
        toggle: (c: string, f?: boolean) => ((f ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)),
      },
      append(...k: any[]) { e.children.push(...k); k.forEach((x) => (x.parent = e)); }, prepend(k: any) { e.children.unshift(k); },
      remove() { if (e.parent) e.parent.children = e.parent.children.filter((c: any) => c !== e); },
      setAttribute(k: string, v: string) { e.attrs[k] = v; }, removeAttribute(k: string) { delete e.attrs[k]; },
      addEventListener() {}, querySelector: () => mk(), querySelectorAll: () => [], closest: () => null,
      set textContent(v: string) { e.text = v; e.children = []; }, get textContent() { return e.text; },
      get lastChild() { return e.children.at(-1); }, set innerHTML(v: string) { e.html = v; }, get innerHTML() { return e.html ?? ""; },
    };
    return e;
  };
  const $ = (s: string) => (els.has(s) ? els.get(s) : (els.set(s, mk(s)), els.get(s)));
  const listeners: Record<string, Function[]> = {};
  const win: any = {
    CustomEvent, addEventListener: (t: string, f: Function) => (listeners[t] ??= []).push(f), removeEventListener: (t: string, f: Function) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== f)),
    dispatchEvent: (e: any) => (listeners[e.type] ?? []).forEach((f) => f(e)),
  };
  const stack: any[] = [null]; let at = 0;
  win.history = { get state() { return stack[at]; }, get length() { return stack.length; }, pushState: (s: any) => { stack.length = at + 1; stack.push(s); at++; }, replaceState: (s: any) => { stack[at] = s; }, back: () => { if (at > 0) { at--; queueMicrotask(() => win.dispatchEvent({ type: "popstate" })); } } };
  const doc: any = { querySelector: $, querySelectorAll: () => [], createElement: () => mk(), body: mk(), documentElement: mk(), fullscreenElement: null, addEventListener() {} };
  const ctx = vm.createContext({
    ...win, window: win, document: doc, history: win.history, console, setInterval: () => 0, setTimeout, clearTimeout, requestAnimationFrame: () => 0,
    navigator: { clipboard: { writeText: async (t: string) => void (ctx.copied = t) } }, localStorage: {}, matchMedia: () => ({ matches: false }), fetch: async () => ({ ok: false, json: async () => ({}) }),
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" }, AudioContext: class {}, Blob: class {}, URL, Date, Promise, JSON, Object, Array, Math, Uint8Array, TextDecoder, TextEncoder, performance, isSecureContext: false, copied: "",
    ...env,
  });
  vm.runInContext(js, ctx);
  return { ctx, $, doc, win, stack, at: () => at, tick: () => new Promise((r) => setTimeout(r, 0)) };
}

test("apps open over the chat; the pill, the transcript and the session stay, and back closes", async () => {
  const b = boot({ name: "me", apps: { budget: { title: "Budget", html: "<p>mounted</p>" } } });
  const list = b.$("#list");
  const transcript = list.children.length;
  b.ctx.window.dotApps.open("budget");
  assert.equal(b.ctx.window.dotApps.current(), "budget");
  assert.ok(b.doc.body.classList.contains("app-open"));
  assert.equal(b.$("#pill").hidden, false);
  assert.equal(b.$("#apps").children[0].innerHTML, "<p>mounted</p>");
  assert.equal(b.stack.length, 2);
  assert.ok(list.children.length > transcript, "the open is logged, nothing is cleared");
  const kept = list.children.length;
  b.ctx.window.history.back();
  await b.tick();
  assert.equal(b.ctx.window.dotApps.current(), null);
  assert.ok(!b.doc.body.classList.contains("app-open"));
  assert.equal(b.$("#pill").hidden, true);
  assert.ok(list.children.length >= kept, "the transcript is untouched by closing");
  // the pill returns to chat
  b.ctx.window.dotApps.open("budget");
  b.$("#pill").onclick();
  assert.equal(b.ctx.window.dotApps.current(), null);
});

test("the open_app and close_app results act on the screen", () => {
  const html = screen({ name: "me", apps: { budget: { title: "Budget", html: "x" } } });
  assert.match(html, /result\?\.app&&!result\.error/);
  assert.match(html, /result\?\.close_app/);
  assert.match(html, /m\.display\.app/);
});

test("a card's app button is drawn only for a known app", () => {
  const html = screen({ name: "me", apps: { budget: { title: "Budget" } } });
  assert.match(html, /c\.app&&CFG\.apps\[c\.app\.name\]/);
  assert.match(html, /"apps":\{"budget":\{"title":"Budget"\}\}/);
});

test("an app's css lands in the page, after the screen's own", () => {
  const html = screen({ name: "me", apps: { a: { title: "A", css: '[data-app="a"]{color:red}' } } });
  assert.ok(html.indexOf('[data-app="a"]{color:red}') > html.indexOf("#pill{"));
});

test("the version sits in info's Build section, shows short sha and date, and copies the full commit", async () => {
  const version = { commit: "a".repeat(40), short: "aaaaaaa", built: "2026-10-12T09:30:00.000Z" };
  const html = screen({ name: "me", version });
  assert.match(html, /<button id="ver"[^>]*>aaaaaaa · 2026-10-12<\/button>/);
  const info = html.slice(html.indexOf('<section id="info"'), html.indexOf("</section>", html.indexOf('<section id="info"')));
  assert.match(info, /<h3>Build<\/h3><button id="ver"/, "in info, under Build");
  assert.equal(html.match(/id="ver"/g)!.length, 1, "and nowhere else on the screen");
  assert.doesNotMatch(screen({ name: "me" }), /id="ver"/);
  const b = boot({ name: "me", version });
  await b.$("#ver").onclick();
  await b.tick();
  assert.equal(b.ctx.copied, "a".repeat(40));
});

test("the version can't break out of the page", () => {
  const html = screen({ name: "x", version: { commit: "</script>", short: "<b>", built: "<i>2026-10-12" } });
  assert.equal(html.split("</script>").length, 2);
  assert.doesNotMatch(html, /<b> ·/);
});

test("every session starts with a start event, a fresh one too", () => {
  const html = screen({ name: "me" });
  assert.match(html, /markStart\(\)/);
  assert.equal(html.match(/markStart\(\);/g)!.length, 2);
});

/** A fake network: answers by path, and records every request. */
function net(routes: Record<string, (body: any, url: string) => { status?: number; json: unknown }>) {
  const calls: { url: string; body: any }[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const path = url.split("?")[0];
    const h = routes[path] ?? routes[Object.keys(routes).find((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1))) ?? ""];
    const out = h ? h(body, url) : { status: 404, json: { error: "no" } };
    const text = JSON.stringify(out.json);
    return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, json: async () => out.json, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(text + "\n") })) }; } } };
  };
  return { fetch, calls };
}
class FakeAudio {
  currentTime = 0; destination = {};
  resume() {} close() {}
  createAnalyser() { return { fftSize: 256, connect() {}, getByteTimeDomainData() {} }; }
}
const sockets: any[] = [];
class FakeSocket { url: string; sent: string[] = []; onclose: any; onopen: any; onmessage: any; readyState = 1;
  constructor(url: string) { this.url = url; sockets.push(this); }
  send(s: string) { this.sent.push(s); } close(code: number) { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code })); } }

const mode = (b: ReturnType<typeof boot>) => b.$("#mode").dataset.mode;

test("the starting mode is the dot's defaultMode until the person picks one", () => {
  assert.equal(mode(boot({ name: "me" })), "demo", "demo by default, so other dots don't change");
  assert.equal(mode(boot({ name: "me", defaultMode: "private" })), "private");
  assert.equal(mode(boot({ name: "me", defaultMode: "private" }, { localStorage: { demo: "1" } })), "demo", "a saved pick wins");
  assert.equal(mode(boot({ name: "me" }, { localStorage: { demo: "0" } })), "private");
  assert.match(screen({ name: "me", defaultMode: "private" }), /"defaultMode":"private"/);
  assert.match(screen({ name: "me", defaultMode: "nonsense" as any }), /"defaultMode":"demo"/);
});

test("switching mode switches typed chat and restarts an open Live session in the new mode", async () => {
  sockets.length = 0;
  const n = net({ "/api/token": () => ({ json: { token: "t", model: "m" } }), "/api/chat": () => ({ json: { reply: "ok" } }) });
  const store: Record<string, string> = {};
  const b = boot({ name: "me" }, { fetch: n.fetch, WebSocket: FakeSocket, AudioContext: FakeAudio, localStorage: store });
  await b.$("#dot").onclick();
  await b.tick();
  assert.equal(sockets.length, 1);
  assert.match(n.calls.at(-1)!.url, /\/token\?safe=1$/);
  b.$("#mode").onclick();
  await b.tick(); await b.tick();
  assert.equal(store.demo, "0", "the pick is kept");
  assert.equal(sockets[0].readyState, 3, "the demo session closed");
  assert.equal(sockets.length, 2, "and a new one started");
  assert.match(n.calls.filter((c) => c.url.includes("/token")).at(-1)!.url, /safe=0$/);
  sockets[1].onopen();
  assert.doesNotMatch(sockets[1].sent[0], /sessionResumption/, "no handle carried across modes");
  await b.tick();
  assert.ok(sockets.length === 2 && sockets[1].readyState === 1, "the old socket closing late doesn't take the new one");
  b.$("#type").value = "hi";
  await b.$("#type").onkeydown({ key: "Enter", target: b.$("#type") });
  assert.equal(n.calls.find((c) => c.url.endsWith("/chat"))!.body.safe, false, "typed chat is private too");
});

test("private mode refused by the server drops back to demo", async () => {
  sockets.length = 0;
  const n = net({ "/api/token": (_b, url) => (url.endsWith("safe=0") ? { status: 403, json: { error: "private mode needs an allowed login" } } : { json: { token: "t", model: "m" } }) });
  const b = boot({ name: "me", defaultMode: "private" }, { fetch: n.fetch, WebSocket: FakeSocket, AudioContext: FakeAudio });
  await b.$("#dot").onclick();
  await b.tick();
  assert.equal(mode(b), "demo");
  assert.equal(sockets.length, 1, "it still starts, in demo");
});

test("a wordmark can put the cursor inside the name", () => {
  assert.match(screen({ name: "hev dot", wordmark: ["hev", "dot"] }), /<div class="wm">hev<span class="cur mid"><\/span>dot</);
  assert.match(screen({ name: "hev dot" }), /<div class="wm">hev dot<span class="cur"><\/span></);
  assert.match(screen({ name: "x", wordmark: ["<b>", "y"] }), /&lt;b&gt;<span class="cur mid">/);
});

test("a semver goes on the tag; the short sha stays in the tag's title, the info pane and the log", async () => {
  const version = { commit: "b".repeat(40), short: "bbbbbbb", built: "2026-10-13T09:30:00.000Z", semver: "1.4.0" };
  const html = screen({ name: "me", version });
  assert.match(html, /<button id="ver" class="row" title="bbbbbbb · copy the build" data-sha="bbbbbbb">1\.4\.0 · 2026-10-13<\/button>/);
  assert.match(screen({ name: "me", version: { ...version, semver: "not<semver>" } }), />bbbbbbb · 2026-10-13</, "a bad semver falls back to the sha");
  const b = boot({ name: "me", version });
  assert.equal(b.$("#logStats").textContent, "1.4.0 · bbbbbbb");
  await b.$("#ver").onclick();
  await b.tick();
  assert.equal(b.ctx.copied, "1.4.0 " + "b".repeat(40));
});

test("photos show as thumbnails in the user's turn, under the orb and in the log", async () => {
  const n = net({ "/api/chat": () => ({ json: { reply: "a tree" } }) });
  const b = boot({ name: "me" }, { fetch: n.fetch });
  vm.runInContext("pending=[{mimeType:'image/jpeg',data:'QUJD',url:'data:image/jpeg;base64,QUJD',thumb:'data:image/jpeg;base64,VEhVTUI='}]", b.ctx);
  b.$("#type").value = "what is it";
  await b.$("#type").onkeydown({ key: "Enter", target: b.$("#type") });
  const turn = b.$("#list").children.find((c: any) => c.className === "m u");
  assert.equal(turn.text, "what is it");
  const imgs = (el: any) => el.children.flatMap((c: any) => c.children).map((i: any) => i.src);
  assert.deepEqual(imgs(turn), ["data:image/jpeg;base64,VEhVTUI="]);
  assert.deepEqual(imgs(b.$("#you")), ["data:image/jpeg;base64,VEhVTUI="]);
  assert.equal(b.$("#you").text, "“what is it”");
  assert.equal(n.calls.find(c => c.url.endsWith("/chat"))!.body.images[0].thumb, "data:image/jpeg;base64,VEhVTUI=", "the thumb goes to the server for the thread");
});

test("the threads drawer lists past threads, resumes one, and closes on back", async () => {
  const OLD = "aaaaaaaa-0000-0000-0000-000000000000";
  const n = net({
    "/api/threads": () => ({ json: { threads: [{ id: OLD, first: "how much on coffee", at: Date.now() - 3600_000 }] } }),
    "/api/threads/*": () => ({ json: { id: OLD, lines: [{ k: "u", text: "how much on coffee", ts: 1, photos: ["data:image/jpeg;base64,QQ=="] }, { k: "d", text: "About forty.", ts: 2 }] } }),
    "/api/chat": () => ({ json: { reply: "ok" } }),
  });
  const b = boot({ name: "me" }, { fetch: n.fetch });
  await b.$("#threadsBtn").onclick();
  assert.ok(b.$("#threads").classList.contains("on"));
  assert.equal(b.$("#threads").inert, false);
  assert.equal(b.stack.length, 2, "opening pushes a history entry, so back closes it");
  const row = b.$("#threadList").children[0];
  assert.match(row.innerHTML, /how much on coffee/);
  assert.match(row.innerHTML, /1 h ago/);
  // back (or swipe-back) closes it
  b.ctx.window.history.back();
  await b.tick();
  assert.ok(!b.$("#threads").classList.contains("on"));
  // open again and tap the thread
  await b.$("#threadsBtn").onclick();
  b.$("#threadList").children[0].onclick();
  await b.tick(); await b.tick();
  assert.ok(!b.$("#threads").classList.contains("on"));
  const list = b.$("#list").children;
  assert.deepEqual(list.map((c: any) => c.text), ["how much on coffee", "About forty."]);
  assert.equal(list[0].children[0].children[0].src, "data:image/jpeg;base64,QQ==");
  assert.equal(b.$("#say").textContent, "About forty.");
  b.$("#type").value = "and tea?";
  await b.$("#type").onkeydown({ key: "Enter", target: b.$("#type") });
  assert.equal(n.calls.find((c) => c.url.endsWith("/chat"))!.body.session, OLD, "the session id carries on");
  // new thread starts fresh
  await b.$("#threadsBtn").onclick();
  b.$("#newThread").onclick();
  assert.equal(b.$("#list").children.length, 0);
  assert.ok(!b.$("#threads").classList.contains("on"));
});

test("Escape closes the threads drawer", async () => {
  const b = boot({ name: "me" }, { fetch: net({ "/api/threads": () => ({ json: { threads: [] } }) }).fetch });
  await b.$("#threadsBtn").onclick();
  assert.equal(b.$("#threadList").textContent, "No past threads yet.");
  b.win.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.ok(!b.$("#threads").classList.contains("on"));
});

test("the header reads ☰, the wordmark, the mode, then a compact i; the log is not in it", () => {
  const html = screen({ name: "hev dot", wordmark: ["hev", "dot"] });
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  const at = (re: RegExp) => header.search(re);
  assert.ok(at(/id="threadsBtn"/) >= 0 && at(/id="threadsBtn"/) < at(/class="wm"/), "☰ left of the wordmark");
  assert.ok(at(/class="wm"/) < at(/id="mode"/) && at(/id="mode"/) < at(/id="infoBtn"/), "then the mode, then info");
  assert.match(header, /<button id="infoBtn" class="ic" aria-label="info"[^>]*>i<\/button>/);
  assert.doesNotMatch(header, /logBtn|id="ver"/, "log and the build moved into info");
  assert.match(html, /<section id="info"[^>]*>.*<button id="logBtn"/, "the log opens from info");
  assert.match(html, /header \.ic\{width:40px;height:40px/, "tap targets of 40px");
});

test("private mode is a shut lock, demo an open one; the words stay for screen readers", () => {
  const b = boot({ name: "me", defaultMode: "private" });
  const m = b.$("#mode");
  assert.equal(m.attrs["aria-label"], "private mode");
  assert.match(m.innerHTML, /^<svg [^>]*stroke="currentColor"[^>]*aria-hidden="true">/, "an inline svg that themes");
  assert.match(m.innerHTML, /a4 4 0 0 1 8 0v4/, "shut");
  assert.ok(m.classList.contains("priv"));
  m.onclick();
  assert.equal(m.attrs["aria-label"], "demo mode");
  assert.doesNotMatch(m.innerHTML, /a4 4 0 0 1 8 0v4/, "open");
  assert.ok(!m.classList.contains("priv"));
  assert.doesNotMatch(m.innerHTML, /🔒|🔓/, "not an emoji");
  assert.equal(boot({ name: "me", modes: false }).$("#mode").hidden, true, "modes:false shows no switch");
});

test("the log opens from info; back and Escape close it and land in info", async () => {
  const b = boot({ name: "me" }, { fetch: net({ "/api/info": () => ({ json: { tools: [] } }) }).fetch });
  await b.$("#infoBtn").onclick();
  assert.ok(b.$("#info").classList.contains("on"));
  assert.equal(b.stack.length, 2);
  b.$("#logBtn").onclick();
  assert.ok(b.$("#log").classList.contains("on"));
  assert.equal(b.stack.length, 3);
  b.ctx.window.history.back();
  await b.tick();
  assert.ok(!b.$("#log").classList.contains("on"), "back closes the log");
  assert.ok(b.$("#info").classList.contains("on"), "and lands in info");
  b.$("#logBtn").onclick();
  b.win.dispatchEvent({ type: "keydown", key: "Escape" });
  await b.tick();
  assert.ok(!b.$("#log").classList.contains("on"), "Escape closes the log");
  assert.ok(b.$("#info").classList.contains("on"), "and lands in info");
  assert.equal(b.at(), 1);
  b.$("#logBtn").onclick();
  b.$("#logClose").onclick();
  await b.tick();
  assert.ok(b.$("#info").classList.contains("on"), "close lands in info too");
  b.win.dispatchEvent({ type: "keydown", key: "Escape" });
  await b.tick();
  assert.ok(!b.$("#info").classList.contains("on"), "a second Escape closes info");
  assert.equal(b.at(), 0, "no history left behind");
  await b.$("#infoBtn").onclick();
  b.ctx.window.history.back();
  await b.tick();
  assert.ok(!b.$("#info").classList.contains("on"), "back closes info");
});

test("text failures retain the draft and never start voice, even with spoken cues configured", async () => {
  for (const status of [404, 500]) {
    sockets.length = 0;
    let audio = 0;
    const n = net({ "/api/chat": () => ({ status, json: { error: "unavailable" } }) });
    const b = boot({ name: "generic", cues: true }, {
      fetch: n.fetch, WebSocket: FakeSocket, AudioContext: class { constructor() { audio++; } },
    });
    b.$("#type").value = "keep my draft";
    await b.$("#type").onkeydown({ key: "Enter" });
    assert.equal(b.$("#type").value, "keep my draft");
    assert.equal(sockets.length, 0);
    assert.equal(audio, 0);
    assert.equal(n.calls.some(c => /token|cue/.test(c.url)), false);
  }
});

test("typing cancels an outstanding voice token request", async () => {
  sockets.length = 0;
  let release!: (v: any) => void;
  const n = net({ "/api/chat": () => ({ json: { reply: "hello" } }) });
  const b = boot({ name: "generic" }, {
    AudioContext: FakeAudio, WebSocket: FakeSocket,
    fetch: (url: string, init: any) => url.includes("/token")
      ? new Promise(resolve => { release = resolve; })
      : n.fetch(url, init),
  });
  await b.$("#dot").onclick();
  b.$("#type").value = "text instead";
  await b.$("#type").onkeydown({ key: "Enter" });
  release({ json: async () => ({ token: "t", model: "m" }) });
  await b.tick();
  assert.equal(sockets.length, 0);
});
