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

test("the screen can start a fresh session", () => {
  const html = screen({ name: "me" });
  assert.match(html, /id="new"/);
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
function boot(opts: Parameters<typeof screen>[0]) {
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
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" }, AudioContext: class {}, Blob: class {}, URL, Date, Promise, JSON, Object, Array, Math, Uint8Array, performance, isSecureContext: false, copied: "",
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

test("the version tag shows short sha and date, and copies the full commit", async () => {
  const version = { commit: "a".repeat(40), short: "aaaaaaa", built: "2026-10-12T09:30:00.000Z" };
  const html = screen({ name: "me", version });
  assert.match(html, /<button id="ver"[^>]*>aaaaaaa · 2026-10-12<\/button>/);
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
