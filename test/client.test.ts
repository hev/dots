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
