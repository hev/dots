// Google Maps as a pack: find a place, how long it takes to get somewhere, and a
// map card on screen with a link that opens the Maps app. Places (New), Routes
// and Static Maps, all on one key.
//
// The key never reaches the phone. A map image is a Static Maps URL with the key
// in it, so show_map stores the request's parameters under a random id and the
// card points at <base>/maps/<id>.png on the dot; that route fetches the image
// here. It serves only ids show_map made, so it isn't an open proxy on the key.

import { memoryStore } from "../server/stores.ts";
import { defineTool, local } from "../server/tools.ts";
import type { Card, Pack, Store } from "../server/types.ts";

export type MapsOptions = {
  apiKey: string;
  /** Where map images are kept between the tool call and the screen's fetch. */
  store?: Store;
  /** The dot's routes. Default "/api". */
  base?: string;
  /** Biases searches and answers "from home", e.g. "Boulder, CO". */
  home?: string;
  fetch?: typeof fetch;
};

const MODES = { drive: "DRIVE", walk: "WALK", bike: "BICYCLE", transit: "TRANSIT" } as const;
const GMAPS_MODE = { drive: "driving", walk: "walking", bike: "bicycling", transit: "transit" } as const;
type Mode = keyof typeof MODES;

type Place = {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  currentOpeningHours?: { openNow?: boolean };
};

const PLACE_FIELDS = [
  "id", "displayName", "formattedAddress", "location", "rating", "userRatingCount",
  "nationalPhoneNumber", "googleMapsUri", "currentOpeningHours.openNow",
];

const mins = (s: string) => Math.round(parseInt(s, 10) / 60);
const say = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim());
const miles = (meters: number) => `${(meters / 1609.34).toFixed(meters < 16000 ? 1 : 0)} mi`;
const mode = (m: unknown): Mode => (typeof m === "string" && m in MODES ? (m as Mode) : "drive");

/** A Google Maps link the phone opens in the app. */
export function directionsUrl(from: string | undefined, to: string, m: Mode = "drive") {
  const q = new URLSearchParams({ api: "1", destination: to, travelmode: GMAPS_MODE[m] });
  if (from) q.set("origin", from);
  return `https://www.google.com/maps/dir/?${q}`;
}

export function maps(o: MapsOptions): Pack {
  const get = o.fetch ?? fetch;
  const store = o.store ?? memoryStore();
  const base = o.base ?? "/api";
  const from = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : o.home);

  async function google(url: string, body: unknown, fields: string[]) {
    const res = await get(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey, "x-goog-fieldmask": fields.join(",") },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}: ${out.error?.message ?? ""}`.slice(0, 200));
    return out;
  }

  async function places(query: string, max = 5): Promise<Place[]> {
    const out = await google(
      "https://places.googleapis.com/v1/places:searchText",
      { textQuery: query, pageSize: max },
      PLACE_FIELDS.map((f) => "places." + f),
    );
    return (out.places as Place[] | undefined) ?? [];
  }

  async function route(a: string, b: string, m: Mode) {
    const out = await google(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      { origin: { address: a }, destination: { address: b }, travelMode: MODES[m] },
      ["routes.duration", "routes.distanceMeters", "routes.description", "routes.polyline.encodedPolyline"],
    );
    const r = (out.routes as { duration: string; distanceMeters: number; description?: string; polyline?: { encodedPolyline: string } }[] | undefined)?.[0];
    if (!r) throw new Error(`no ${m} route from ${a} to ${b}`);
    return r;
  }

  /** Stores a Static Maps request and returns the dot URL that serves it. */
  async function image(params: [string, string][]) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await store.put(`map:${id}`, params, 24 * 3600);
    return `${base}/maps/${id}.png`;
  }
  const STYLE: [string, string][] = [["size", "640x360"], ["scale", "2"], ["maptype", "roadmap"]];

  const summary = (p: Place) => ({
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    ...(p.rating ? { rating: `${p.rating} (${p.userRatingCount ?? 0})` } : {}),
    ...(p.currentOpeningHours?.openNow !== undefined ? { open_now: p.currentOpeningHours.openNow } : {}),
    ...(p.nationalPhoneNumber ? { phone: p.nationalPhoneNumber } : {}),
  });

  const tools = local([
    defineTool({
      name: "find_place",
      description:
        "Find places by what they are or their name: a dentist, a coffee shop, a store. Gives name, address, rating, whether it's open and phone number.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, e.g. 'dentist' or 'Blue Bottle'" },
          near: { type: "string", description: `Where${o.home ? ` (default ${o.home})` : ""}` },
        },
        required: ["query"],
      },
      run: async (a) => {
        const near = from(a.near);
        const found = await places(near ? `${a.query} near ${near}` : String(a.query));
        return { places: found.map(summary) };
      },
    }),
    defineTool({
      name: "travel_time",
      description: "How long it takes to get from one place to another, and how far, by car, on foot, by bike or by transit, leaving now.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "An address or a place name" },
          from: { type: "string", description: `Where from${o.home ? ` (default home, ${o.home})` : ""}` },
          mode: { type: "string", enum: Object.keys(MODES) },
        },
        required: ["to"],
      },
      run: async (a) => {
        const start = from(a.from);
        if (!start) return { error: "where from?" };
        const m = mode(a.mode);
        const r = await route(start, String(a.to), m);
        return { from: start, to: a.to, mode: m, time: say(mins(r.duration)), distance: miles(r.distanceMeters), ...(r.description ? { via: r.description } : {}) };
      },
    }),
    defineTool({
      name: "show_map",
      kind: "display",
      description:
        "Put a map card on screen with a button that opens Google Maps: one place (pass place), or a route (pass to, and from if not home). Use when asked to show, or for directions.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "A place to show" },
          to: { type: "string", description: "Destination, for a route" },
          from: { type: "string", description: "Start, for a route" },
          mode: { type: "string", enum: Object.keys(MODES) },
        },
      },
      run: async (a): Promise<{ card: Card } | { error: string }> => {
        if (typeof a.to === "string" && a.to) {
          const start = from(a.from);
          if (!start) return { error: "where from?" };
          const m = mode(a.mode);
          const r = await route(start, a.to, m);
          const t = say(mins(r.duration));
          const src = await image([
            ...STYLE,
            ["markers", `color:0x1a7f37|label:A|${start}`],
            ["markers", `color:0xd93025|label:B|${a.to}`],
            ...(r.polyline ? [["path", `weight:5|color:0xe25822ff|enc:${r.polyline.encodedPolyline}`] as [string, string]] : []),
          ]);
          return {
            card: {
              title: a.to,
              subtitle: `${t} · ${miles(r.distanceMeters)}${r.description ? ` via ${r.description}` : ""}`,
              image: { src, alt: `Route from ${start} to ${a.to}` },
              link: { url: directionsUrl(start, a.to, m), label: "Directions" },
              note: `The route is on screen: ${t} by ${m}. Tapping it opens Google Maps.`,
            },
          };
        }
        if (typeof a.place !== "string" || !a.place) return { error: "pass place, or to for a route" };
        const near = o.home;
        const p = (await places(near ? `${a.place} near ${near}` : a.place, 1))[0];
        if (!p) return { error: `couldn't find ${a.place}` };
        const at = p.location ? `${p.location.latitude},${p.location.longitude}` : (p.formattedAddress ?? a.place);
        const s = summary(p);
        const src = await image([...STYLE, ["zoom", "15"], ["center", at], ["markers", `color:0xe25822|${at}`]]);
        return {
          card: {
            title: s.name,
            subtitle: s.address,
            lines: [
              ...(s.rating ? [{ k: "rating", v: s.rating }] : []),
              ...(s.open_now !== undefined ? [{ k: "now", v: s.open_now ? "open" : "closed" }] : []),
              ...(s.phone ? [{ k: "phone", v: s.phone }] : []),
            ],
            image: { src, alt: `Map of ${s.name}` },
            link: { url: p.googleMapsUri ?? directionsUrl(undefined, s.address || a.place), label: "Open in Maps" },
            note: `${s.name} is on screen with a button to open it in Google Maps.`,
          },
        };
      },
    }),
  ]);

  return {
    name: "Maps",
    tools,
    labels: { find_place: "looking it up", travel_time: "travel time", show_map: "the map" },
    guidance:
      "- For anything about where a place is, how far, or how long to get there, use these; never guess a distance, time or address.\n" +
      "- When asked to show something or for directions, use show_map, then say one line about it.",
    async routes(req) {
      const m = new URL(req.url).pathname.match(new RegExp(`^${base}/maps/([0-9a-f]{16})\\.png$`));
      if (!m || req.method !== "GET") return null;
      const params = (await store.get(`map:${m[1]}`)) as [string, string][] | undefined;
      if (!params) return new Response("gone", { status: 404 });
      const res = await get(`https://maps.googleapis.com/maps/api/staticmap?${new URLSearchParams([...params, ["key", o.apiKey]])}`);
      if (!res.ok) return new Response("map failed", { status: 502 });
      return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "image/png", "cache-control": "private, max-age=86400" } });
    },
  };
}
