import { liveSetup } from "../gemini-live/index.ts";
import type { SessionSetup } from "../server/types.ts";
import { decode64, encode64, inputAudio, outputAudio } from "./audio.ts";

/** Host adapters wrap their websocket implementation in this small interface. */
export type PhoneSocket = {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
};
export type PhoneOptions = {
  live?: boolean;
  accountSid: string;
  authToken: string;
  from: string;
  allowlist: readonly string[];
  /** Public HTTPS origin. The host must preserve this exact URL for signatures. */
  publicUrl: string;
  maxSeconds: number;
  gemini: { apiKey: string; model: string; voice?: string };
  /** Server-owned persona. Phone sessions expose no tools by default. */
  persona: string;
  /** Resolves once open; never connect Gemini from a browser. */
  connectGemini(url: string): Promise<PhoneSocket>;
  fetch?: typeof fetch;
  schedule?: (callback: () => void, ms: number) => () => void;
  onError?: (error: unknown) => void;
};
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

/** Twilio HMAC-SHA1 over the public URL and sorted form parameters. */
export async function twilioSignature(token: string, url: string, params = new URLSearchParams()): Promise<string> {
  let message = url;
  for (const key of [...new Set(params.keys())].sort()) {
    for (const value of [...new Set(params.getAll(key))].sort()) message += key + value;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return encode64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}
async function signed(o: PhoneOptions, request: Request, params = new URLSearchParams()) {
  const expected = await twilioSignature(o.authToken, request.url, params);
  const actual = request.headers.get("x-twilio-signature") ?? "";
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
  return diff === 0;
}
type Call = { id: string; sid?: string; token: string; consumed: boolean; answered: boolean; cancel?: () => void; socket?: PhoneSocket; gemini?: PhoneSocket; ending?: Promise<void> };

/** One coordinator per Twilio caller. Dial is a server API, never an unauthenticated HTTP route. */
export function phone(o: PhoneOptions) {
  if (!Number.isInteger(o.maxSeconds) || o.maxSeconds < 1 || o.maxSeconds > 14400) throw new Error("Invalid phone length cap");
  if (!/^\+[1-9]\d{7,14}$/.test(o.from)) throw new Error("Invalid caller number");
  const origin = new URL(o.publicUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.port || origin.username || origin.password) throw new Error("publicUrl must be an HTTPS origin");
  const base = origin.origin;
  const fetcher = o.fetch ?? fetch;
  const schedule = o.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  let active: Call | undefined;
  const report = (e: unknown) => o.onError?.(e);
  async function rest(path: string, body: URLSearchParams) {
    const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}/Calls${path}.json`, {
      method: "POST", headers: { authorization: `Basic ${btoa(`${o.accountSid}:${o.authToken}`)}`, "content-type": "application/x-www-form-urlencoded" }, body,
    });
    if (!res.ok) throw new Error(`Twilio call request failed (${res.status})`);
    return res.json() as Promise<{ sid: string }>;
  }
  function release(call: Call) {
    if (active === call) active = undefined;
    call.cancel?.(); call.socket?.close(); call.gemini?.close();
  }
  async function hangup(call = active): Promise<void> {
    if (!call || active !== call) return;
    if (call.ending) return call.ending;
    call.ending = (async () => {
      if (!call.sid) throw new Error("Call SID is not available; call remains reserved");
      await rest(`/${encodeURIComponent(call.sid)}`, new URLSearchParams({ Status: "completed" }));
      release(call);
    })();
    try { await call.ending; } catch (error) { call.ending = undefined; throw error; }
  }
  async function dial(to: string) {
    if (!/^\+[1-9]\d{7,14}$/.test(to) || !o.allowlist.includes(to)) throw new Error("Phone number is not allowed");
    if (active) throw new Error("A phone call is already active");
    if (!o.live) return { dryRun: true as const, to, from: o.from, maxSeconds: o.maxSeconds };
    const call: Call = { id: crypto.randomUUID(), token: crypto.randomUUID(), consumed: false, answered: false };
    active = call; // Reserve before any await, including concurrent dial requests.
    try {
      const result = await rest("", new URLSearchParams({
        To: to, From: o.from, Url: `${base}/phone/answer?id=${call.id}`, Method: "POST",
        MachineDetection: "Enable", Timeout: "30", TimeLimit: String(o.maxSeconds),
        StatusCallback: `${base}/phone/status?id=${call.id}`, StatusCallbackMethod: "POST", StatusCallbackEvent: "completed",
      }));
      if (!result.sid || (call.sid && call.sid !== result.sid)) throw new Error("Unexpected Twilio call SID");
      call.sid = result.sid;
      if (active === call) call.cancel = schedule(() => { void hangup(call).catch(report); }, (o.maxSeconds + 30) * 1000);
      return { dryRun: false as const, callSid: result.sid };
    } catch (error) {
      // A failed response can follow a successful dial. Keep the reservation until
      // a signed terminal callback (or explicit hangup) reconciles the effect.
      report(error); throw error;
    }
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== base || !["/phone/answer", "/phone/status"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const params = new URLSearchParams(await request.text());
    if (!await signed(o, request, params)) return new Response("Forbidden", { status: 403 });
    const call = active;
    if (!call || url.searchParams.get("id") !== call.id || !params.get("CallSid") || (call.sid && params.get("CallSid") !== call.sid)) return new Response("Unknown call", { status: 403 });
    call.sid = params.get("CallSid")!;
    if (url.pathname === "/phone/status") {
      if (terminal.has(params.get("CallStatus") ?? "")) release(call);
      return new Response(null, { status: 204 });
    }
    if (params.get("AnsweredBy") !== "human") {
      await hangup(call);
      return new Response("<Response><Hangup/></Response>", { headers: { "content-type": "text/xml" } });
    }
    if (!call.answered) {
      call.answered = true;
      call.cancel?.();
      call.cancel = schedule(() => { void hangup(call).catch(report); }, o.maxSeconds * 1000);
    }
    return new Response(`<Response><Connect><Stream url="${xml(base.replace(/^https:/, "wss:") + "/phone/stream")}"><Parameter name="token" value="${xml(call.token)}"/></Stream></Connect><Hangup/></Response>`, { headers: { "content-type": "text/xml" } });
  }
  /** Validate BEFORE the host accepts the WebSocket upgrade. */
  async function authorizeStream(request: Request): Promise<boolean> {
    return !!(o.live && active?.answered && request.method === "GET" && request.url === `${base}/phone/stream` && await signed(o, request));
  }
  /** Recheck the upgrade signature when attaching the host socket. */
  async function stream(request: Request, socket: PhoneSocket) {
    if (!await authorizeStream(request)) { socket.close(); throw new Error("Unauthorized phone stream"); }
    let call: Call | undefined, streamSid = "", ready = false, stopped = false;
    const up = inputAudio(); let down = outputAudio();
    const cancelStart = schedule(() => { socket.close(); }, 5000);
    const end = () => {
      if (stopped) return; stopped = true; cancelStart();
      socket.close();
      if (call) { call.gemini?.close(); void hangup(call).catch(report); }
    };
    socket.onClose(end); socket.onError(end);
    socket.onMessage(data => { void receive(data).catch(error => { report(error); end(); }); });
    async function receive(data: string) {
      if (stopped) return;
      if (data.length > 256_000) throw new Error("Oversize phone frame");
      const message = JSON.parse(data);
      if (message.event === "connected") return;
      if (message.event === "start") {
        const current = active, start = message.start;
        if (call || !current?.answered || current.consumed || start?.customParameters?.token !== current.token || start.callSid !== current.sid || !start.streamSid || start.mediaFormat?.encoding !== "audio/x-mulaw" || start.mediaFormat?.sampleRate !== 8000 || start.mediaFormat?.channels !== 1) throw new Error("Invalid phone stream");
        call = current; current.consumed = true; current.socket = socket; streamSid = start.streamSid; cancelStart();
        const gemini = await o.connectGemini(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(o.gemini.apiKey)}`);
        if (stopped || active !== current) { gemini.close(); return; }
        current.gemini = gemini;
        gemini.onClose(end); gemini.onError(end);
        gemini.onMessage(raw => {
          try {
            const response = JSON.parse(raw);
            if (response.setupComplete) ready = true;
            if (response.error || response.goAway) { end(); return; }
            if (response.serverContent?.interrupted) { down = outputAudio(); socket.send(JSON.stringify({ event: "clear", streamSid })); }
            for (const part of response.serverContent?.modelTurn?.parts ?? []) {
              if (!part.inlineData) continue;
              if (!/^audio\/pcm(?:;rate=24000)?$/.test(part.inlineData.mimeType)) throw new Error("Unexpected Gemini audio format");
              const audio = down(decode64(part.inlineData.data));
              if (audio.length) socket.send(JSON.stringify({ event: "media", streamSid, media: { payload: encode64(audio) } }));
            }
          } catch (error) { report(error); end(); }
        });
        const setup: SessionSetup = { persona: o.persona, tools: [] };
        gemini.send(JSON.stringify({ setup: liveSetup(o.gemini, setup) }));
      } else if (message.event === "media") {
        if (!call || message.streamSid !== streamSid) throw new Error("Media before authenticated start");
        if (ready && message.media?.track === "inbound") call.gemini!.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: encode64(up(decode64(message.media.payload))) } } }));
      } else if (message.event === "stop") end();
    }
    return { close: end };
  }
  return { dial, handle, authorizeStream, stream, hangup, busy: () => !!active };
}
