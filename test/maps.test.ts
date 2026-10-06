import assert from "node:assert/strict";
import { test } from "node:test";
import { screen } from "../src/client/index.ts";
import { directionsUrl, maps } from "../src/maps/index.ts";
import { defineDot } from "../src/server/index.ts";
import type { Card } from "../src/server/types.ts";

const KEY = "AIzaFAKEFAKEFAKEFAKE";
function fakeFetch() {
  const calls: { url: string; headers: Headers; body?: unknown }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (u.includes("places:searchText"))
      return Response.json({ places: [{ id: "p1", displayName: { text: "Pearl St Dental" }, formattedAddress: "1 Pearl St, Boulder", location: { latitude: 40, longitude: -105 }, rating: 4.8, userRatingCount: 120, nationalPhoneNumber: "(303) 555-0100", googleMapsUri: "https://maps.google.com/?cid=1", currentOpeningHours: { openNow: true } }] });
    if (u.includes("computeRoutes"))
      return Response.json({ routes: [{ duration: "2328s", distanceMeters: 48000, description: "US-36 W", polyline: { encodedPolyline: "abc" } }] });
    if (u.includes("staticmap")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ctx = { session: "", who: "me@x", demo: false };

async function dot() {
  const { f, calls } = fakeFetch();
  const pack = maps({ apiKey: KEY, home: "Boulder, CO", fetch: f });
  const d = await defineDot({ name: "t", persona: ({ guidance }) => guidance, voice: { name: "x", mint: async () => ({}) }, tools: [], packs: [pack], logins: ["me@x"] });
  return { d, calls, pack };
}

test("find_place searches near home and sends the key in a header", async () => {
  const { d, calls } = await dot();
  const r = await d.invoke("find_place", { query: "dentist" }, ctx);
  assert.match(JSON.stringify(r.body), /Pearl St Dental/);
  assert.equal((calls[0]!.body as { textQuery: string }).textQuery, "dentist near Boulder, CO");
  assert.equal(calls[0]!.headers.get("x-goog-api-key"), KEY);
  assert.doesNotMatch(calls[0]!.url, /key=/);
});

test("travel_time answers in minutes and miles", async () => {
  const { d } = await dot();
  const r = (await d.invoke("travel_time", { to: "Denver" }, ctx)).body as Record<string, string>;
  assert.equal(r.time, "39 min");
  assert.equal(r.distance, "30 mi");
  assert.equal(r.from, "Boulder, CO");
});

test("show_map returns a card whose image is served by the dot, never with the key", async () => {
  const { d, calls } = await dot();
  const { card } = (await d.invoke("show_map", { to: "Denver Airport" }, ctx)).body as { card: Card };
  assert.match(card.image!.src, /^\/api\/maps\/[0-9a-f]{16}\.png$/);
  assert.ok(!JSON.stringify(card).includes(KEY));
  assert.equal(card.link!.url, directionsUrl("Boulder, CO", "Denver Airport", "drive"));
  const img = await d.fetch(new Request("https://dot.example" + card.image!.src));
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(calls.at(-1)!.url, /staticmap\?.*enc%3Aabc.*key=AIza/);
  assert.equal((await d.fetch(new Request("https://dot.example/api/maps/0000000000000000.png"))).status, 404);
});

test("a place card has its lines and a Maps link; display needs an allowed login", async () => {
  const { d } = await dot();
  const { card } = (await d.invoke("show_map", { place: "Pearl St Dental" }, ctx)).body as { card: Card };
  assert.deepEqual(card.lines, [{ k: "rating", v: "4.8 (120)" }, { k: "now", v: "open" }, { k: "phone", v: "(303) 555-0100" }]);
  assert.equal(card.link!.url, "https://maps.google.com/?cid=1");
  assert.equal((await d.invoke("show_map", { place: "x" }, { ...ctx, who: null })).status, 403);
});

test("pack guidance reaches the persona, and its labels reach the screen", async () => {
  const { d, pack } = await dot();
  assert.match(await d.persona(true, "voice"), /^Maps:\n- For anything about where/);
  assert.match(screen({ name: "t", packs: [pack] }), /"show_map":"the map"/);
});
