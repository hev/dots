import assert from "node:assert/strict";
import { test } from "node:test";
import { installHead, installProblems, installRoutes, manifest, SERVICE_WORKER } from "../src/install/index.ts";

const opts = {
  name: "hev dot",
  shortName: "dot",
  color: "#fafaf5",
  icons: { any192: "/icon-192.png", any512: "/icon.png", maskable512: "/icon-maskable.png", apple: "/apple-touch-icon.png" },
};

test("the manifest has what Chrome needs to install", () => {
  const m = manifest(opts);
  assert.equal(m.display, "standalone");
  assert.equal(m.short_name, "dot");
  assert.deepEqual(installProblems("https://mini.tail0.ts.net", m), []);
});

test("a self-signed IP origin says why it won't install", () => {
  const p = installProblems("https://100.64.0.7:8771", manifest(opts));
  assert.equal(p.length, 1);
  assert.match(p[0]!, /bare IP/);
  assert.match(installProblems("http://dot.example", manifest(opts))[0]!, /HTTPS/);
  assert.deepEqual(installProblems("http://localhost:8770", manifest(opts)), []);
});

test("missing icons are named", () => {
  const m = manifest(opts);
  m.icons = m.icons.filter((i) => i.purpose !== "maskable");
  assert.match(installProblems("https://dot.example", m).join(), /maskable/);
});

test("routes serve the manifest and the worker, and pass everything else on", async () => {
  const route = installRoutes(opts);
  const mf = route(new Request("https://dot.example/manifest.webmanifest"))!;
  assert.equal(mf.headers.get("content-type"), "application/manifest+json");
  assert.equal((await mf.json()).name, "hev dot");
  const sw = route(new Request("https://dot.example/sw.js"))!;
  assert.equal(await sw.text(), SERVICE_WORKER);
  assert.equal(route(new Request("https://dot.example/api/tool")), null);
});

test("head tags escape and point at the apple icon", () => {
  const h = installHead({ ...opts, name: 'a "dot"', shortName: undefined });
  assert.match(h, /apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(h, /content="a &quot;dot&quot;"/);
});
