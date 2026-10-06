// Installing a dot on a phone as an app: its own icon, no browser badge, opening
// straight into the voice screen.
//
// Chrome installs a web app (and offers to) only when all of these hold:
// the page is on valid HTTPS (a self-signed or click-through certificate stops
// the service worker from registering), a service worker controls the page, and
// the manifest has 192 and 512 px icons. Short of that, Android's "Add to Home
// screen" makes a plain shortcut with a Chrome badge on the icon. A dot on a
// tailnet gets its certificate from `tailscale serve`, never from a raw IP.

export interface InstallOptions {
  name: string;
  shortName?: string;
  description?: string;
  /** theme and splash color, e.g. "#fafaf5" */
  color: string;
  background?: string;
  icons: {
    /** 192x192 png */
    any192: string;
    /** 512x512 png */
    any512: string;
    /** 512x512 png with the subject inside the central 80% circle; Android crops to it */
    maskable512: string;
    /** 180x180 png for iOS home screens; defaults to any192 */
    apple?: string;
  };
  startUrl?: string;
  scope?: string;
}

export interface WebManifest {
  name: string;
  short_name: string;
  description?: string;
  id: string;
  start_url: string;
  scope: string;
  display: "standalone";
  display_override: string[];
  orientation: "portrait";
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: "any" | "maskable" }[];
}

export function manifest(o: InstallOptions): WebManifest {
  const start = o.startUrl ?? "/";
  return {
    name: o.name,
    short_name: o.shortName ?? o.name,
    ...(o.description ? { description: o.description } : {}),
    id: start,
    start_url: start,
    scope: o.scope ?? "/",
    display: "standalone",
    display_override: ["fullscreen", "standalone"],
    orientation: "portrait",
    theme_color: o.color,
    background_color: o.background ?? o.color,
    icons: [
      { src: o.icons.any192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: o.icons.any512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: o.icons.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** The tags that go in the voice screen's <head>. */
export function installHead(o: InstallOptions, manifestUrl = "/manifest.webmanifest"): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return [
    `<link rel="manifest" href="${esc(manifestUrl)}">`,
    `<meta name="theme-color" content="${esc(o.color)}">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="${esc(o.shortName ?? o.name)}">`,
    `<link rel="icon" href="${esc(o.icons.any192)}">`,
    `<link rel="apple-touch-icon" href="${esc(o.icons.apple ?? o.icons.any192)}">`,
  ].join("\n");
}

/**
 * A worker that makes the dot installable and caches nothing: every request goes
 * to the dot's server, so what's on screen is always live.
 */
export const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;

/**
 * Serve the manifest and the worker from a dot's fetch handler. Returns null for
 * any other path, so it chains: `return install(req) ?? dot.fetch(req)`.
 */
export function installRoutes(o: InstallOptions, paths = { manifest: "/manifest.webmanifest", worker: "/sw.js" }) {
  const body = JSON.stringify(manifest(o));
  return (req: Request): Response | null => {
    const p = new URL(req.url).pathname;
    if (p === paths.manifest) return new Response(body, { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } });
    if (p === paths.worker) return new Response(SERVICE_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
    return null;
  };
}

/**
 * Why a dot at this origin won't install as an app, in plain words; empty when it
 * can. Checks what can be known without a browser: the scheme, a bare-IP host
 * (no public certificate, so it's self-signed) and the manifest's icons.
 */
export function installProblems(origin: string, m: WebManifest): string[] {
  const out: string[] = [];
  const u = new URL(origin);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) out.push("not served over HTTPS");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && !local)
    out.push("served from a bare IP, so its certificate is self-signed; put it behind a real name (tailscale serve on a tailnet)");
  const has = (size: string, purpose: string) => m.icons.some((i) => i.sizes === size && i.purpose === purpose);
  if (!has("192x192", "any")) out.push("no 192x192 icon");
  if (!has("512x512", "any")) out.push("no 512x512 icon");
  if (!has("512x512", "maskable")) out.push("no maskable icon, so Android shrinks the icon onto a white circle");
  return out;
}

/**
 * Client side: register the worker and hand back an install button's handler.
 * `onAvailable(true)` fires when the browser will install (show the button);
 * `onAvailable(false)` once it's installed or declined.
 */
export function installPrompt(onAvailable: (can: boolean) => void, worker = "/sw.js"): () => Promise<void> {
  let ev: (Event & { prompt(): Promise<void>; userChoice: Promise<unknown> }) | null = null;
  if (typeof window === "undefined") return async () => {};
  navigator.serviceWorker?.register(worker).catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    ev = e as typeof ev;
    onAvailable(true);
  });
  window.addEventListener("appinstalled", () => {
    ev = null;
    onAvailable(false);
  });
  return async () => {
    if (!ev) return;
    const e = ev;
    ev = null;
    await e.prompt();
    await e.userChoice;
    onAvailable(false);
  };
}
