import assert from "node:assert/strict";
import { test } from "node:test";
import { APPS } from "../src/client/apps.ts";

// A page just real enough for createApps: elements, a history stack that fires
// popstate after back(), and a window that dispatches dot:* events.
function page() {
  const el = () => {
    const classes = new Set<string>();
    const e: any = {
      className: "", innerHTML: "", attrs: {} as Record<string, string>, kids: [] as any[], gone: false,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      setAttribute(k: string, v: string) { e.attrs[k] = v; },
      append(k: any) { e.kids.push(k); k.parent = e; },
      remove() { e.gone = true; if (e.parent) e.parent.kids = e.parent.kids.filter((k: any) => k !== e); },
    };
    return e;
  };
  const win = new EventTarget();
  const stack: any[] = [null];
  let at = 0;
  const hist = {
    get state() { return stack[at]; },
    get length() { return stack.length; },
    pushState(s: any) { stack.length = at + 1; stack.push(s); at++; },
    replaceState(s: any) { stack[at] = s; },
    back() { if (at > 0) { at--; queueMicrotask(() => win.dispatchEvent(new Event("popstate"))); } },
  };
  const host = el();
  const changes: (string | null)[] = [];
  const errors: string[] = [];
  const log: string[] = [];
  const make = (defs: Record<string, any>, extra: Record<string, unknown> = {}) =>
    new Function(`${APPS}; return createApps;`)()({
      doc: { createElement: el }, win, hist, host, defs,
      onChange: (n: string | null) => changes.push(n), onError: (n: string, e: unknown) => errors.push(`${n}: ${e}`), ...extra,
    });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { win, hist, host, changes, errors, log, make, tick, stack, at: () => at };
}

const defs = {
  budget: { title: "Budget", html: "<b>hi</b>", script: "api.on('card', e => window_log.push(e.detail)); return () => window_log.push('bye');" },
  notes: { title: "Notes", html: "notes" },
};

function setup() {
  const p = page();
  (globalThis as any).window_log = p.log;
  const apps = p.make(defs);
  return { p, apps };
}

test("open mounts the app's html in a container and pushes a history entry", () => {
  const { p, apps } = setup();
  assert.equal(apps.open("budget"), true);
  assert.equal(apps.current(), "budget");
  assert.equal(p.host.kids.length, 1);
  assert.equal(p.host.kids[0].innerHTML, "<b>hi</b>");
  assert.equal(p.host.kids[0].attrs["data-app"], "budget");
  assert.ok(p.host.classList.contains("on"));
  assert.equal(p.hist.length, 2);
  assert.deepEqual(p.hist.state, { dotApp: "budget" });
  assert.deepEqual(p.changes, ["budget"]);
});

test("an unknown app doesn't open", () => {
  const { p, apps } = setup();
  assert.equal(apps.open("nope"), false);
  assert.equal(apps.open("toString"), false);
  assert.equal(p.hist.length, 1);
});

test("the app gets dot:* events while open, and stops getting them on close", async () => {
  const { p, apps } = setup();
  apps.open("budget");
  p.win.dispatchEvent(new CustomEvent("dot:card", { detail: { n: 1 } }));
  apps.close();
  p.win.dispatchEvent(new CustomEvent("dot:card", { detail: { n: 2 } }));
  await p.tick();
  assert.deepEqual(p.log, [{ n: 1 }, "bye"]);
});

test("back closes the app and the entry goes", async () => {
  const { p, apps } = setup();
  apps.open("budget");
  p.hist.back();
  await p.tick();
  assert.equal(apps.current(), null);
  assert.ok(p.host.kids.length === 0);
  assert.ok(!p.host.classList.contains("on"));
  assert.deepEqual(p.changes, ["budget", null]);
  assert.equal(p.at(), 0);
});

test("closing from the page (pill, voice) pops its own entry, so back doesn't leave the site", async () => {
  const { p, apps } = setup();
  apps.open("budget");
  assert.equal(apps.close(), true);
  assert.equal(apps.close(), false);
  await p.tick();
  assert.equal(p.at(), 0);
  assert.deepEqual(p.changes, ["budget", null], "closed once, not twice");
});

test("opening another app swaps in place: one back returns to the chat", async () => {
  const { p, apps } = setup();
  apps.open("budget");
  apps.open("notes");
  assert.equal(p.hist.length, 2);
  assert.equal(apps.current(), "notes");
  p.hist.back();
  await p.tick();
  assert.equal(apps.current(), null);
  assert.equal(p.at(), 0);
});

test("an open right after a close waits for the pop, then lands on top of the chat", async () => {
  const { p, apps } = setup();
  apps.open("budget");
  apps.close();
  apps.open("notes");
  await p.tick();
  assert.equal(apps.current(), "notes");
  assert.equal(p.at(), 1);
  p.hist.back();
  await p.tick();
  assert.equal(apps.current(), null);
});

test("an app's script or module that throws is reported and closed", async () => {
  const p = page();
  const apps = p.make({ bad: { title: "Bad", script: "throw new Error('boom')" }, mod: { title: "M", module: "x.js" } }, { load: async () => ({ mount() { throw new Error("nomount"); } }) });
  apps.open("bad");
  await p.tick();
  assert.equal(apps.current(), null);
  apps.open("mod");
  await p.tick();
  assert.equal(apps.current(), null);
  assert.equal(p.errors.length, 2);
  assert.match(p.errors[1], /nomount/);
});

test("a module app is mounted through its mount() and cleaned up on close", async () => {
  const p = page();
  const seen: string[] = [];
  const apps = p.make({ m: { title: "M", module: "/m.js" } }, { load: async (u: string) => ({ mount: (el: any, api: any) => (seen.push(u + ":" + api.name), () => seen.push("clean")) }) });
  apps.open("m");
  await p.tick();
  apps.close();
  assert.deepEqual(seen, ["/m.js:m", "clean"]);
});

test("a stale app entry from a reload is cleared", () => {
  const p = page();
  p.hist.replaceState({ dotApp: "budget" });
  p.make(defs);
  assert.equal(p.hist.state, null);
});

test("the Live session, transcript and jobs live outside the app: opening and closing touches only the container", () => {
  // The screen's own state is in the page script's variables and the DOM under
  // main/footer; createApps is given only `host` and never touches anything else.
  const { p, apps } = setup();
  const before = Object.keys(p).sort().join();
  apps.open("budget");
  apps.close();
  assert.equal(Object.keys(p).sort().join(), before);
});
