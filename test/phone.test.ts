import { test } from "node:test";
import assert from "node:assert/strict";
import { phone, twilioSignature } from "../src/phone/index.ts";
import type { PhoneOptions, PhoneSocket } from "../src/phone/index.ts";
import { decode64, encode64, decodeMuLaw, encodeMuLaw, inputAudio, outputAudio } from "../src/phone/audio.ts";

class Socket implements PhoneSocket {
  sent: any[] = []; closed = false;
  message: (data: string) => void = () => {};
  closing: () => void = () => {};
  error: () => void = () => {};
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { if (!this.closed) { this.closed = true; this.closing(); } }
  onMessage(handler: (data: string) => void) { this.message = handler; }
  onClose(handler: () => void) { this.closing = handler; }
  onError(handler: () => void) { this.error = handler; }
  emit(message: unknown) { this.message(JSON.stringify(message)); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(extra: Partial<PhoneOptions> = {}) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const timers: { fn: () => void; ms: number; canceled: boolean }[] = [];
  const gemini = new Socket(); const connections: string[] = []; const errors: unknown[] = [];
  const options: PhoneOptions = {
    live: true, accountSid: "ACtest", authToken: "secret", from: "+14155550100", allowlist: ["+14155550101"],
    publicUrl: "https://phone.example", maxSeconds: 60,
    gemini: { apiKey: "server-secret", model: "models/test-live" }, persona: "Be concise.",
    fetch: async (url, init) => { requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) }); return Response.json({ sid: "CAtest" }); },
    connectGemini: async url => { connections.push(url); return gemini; },
    schedule: (fn, ms) => { const timer = { fn, ms, canceled: false }; timers.push(timer); return () => { timer.canceled = true; }; },
    onError: error => errors.push(error), ...extra,
  };
  const adapter = phone(options);
  async function callback(path: "answer" | "status", values: Record<string, string>, signature = true) {
    const url = requests[0]!.body.get(path === "answer" ? "Url" : "StatusCallback")!;
    const body = new URLSearchParams({ CallSid: "CAtest", ...values });
    return adapter.handle(new Request(url, { method: "POST", body, headers: { "x-twilio-signature": signature ? await twilioSignature(options.authToken, url, body) : "bad" } }));
  }
  async function upgrade(valid = true) {
    const url = `${options.publicUrl}/phone/stream`;
    return new Request(url, { headers: { "x-twilio-signature": valid ? await twilioSignature(options.authToken, url) : "bad" } });
  }
  async function answer() {
    const res = await callback("answer", { AnsweredBy: "human" });
    return (await res.text()).match(/name="token" value="([^"]+)"/)![1]!;
  }
  return { adapter, requests, timers, gemini, connections, errors, callback, upgrade, answer };
}
const start = (token: string) => ({ event: "start", start: { callSid: "CAtest", streamSid: "MStest", customParameters: { token }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });

test("dry run validates policy and never calls Twilio or Gemini", async () => {
  const h = harness({ live: false });
  assert.deepEqual(await h.adapter.dial("+14155550101"), { dryRun: true, to: "+14155550101", from: "+14155550100", maxSeconds: 60 });
  await assert.rejects(h.adapter.dial("+14155550102"), /not allowed/);
  await assert.rejects(h.adapter.dial("14155550101"), /not allowed/);
  assert.equal(h.requests.length, 0); assert.equal(h.connections.length, 0);
  assert.equal(await h.adapter.authorizeStream(await h.upgrade()), false);
});
test("dial reserves before await, uses AMD and provider length limit", async () => {
  const h = harness(); const first = h.adapter.dial("+14155550101");
  await assert.rejects(h.adapter.dial("+14155550101"), /already active/); await first;
  const body = h.requests[0]!.body;
  assert.equal(body.get("MachineDetection"), "Enable"); assert.equal(body.get("TimeLimit"), "60");
  assert.equal(body.get("Timeout"), "30"); assert.equal(h.timers[0]!.ms, 90000);
  const token = await h.answer(); assert.ok(token); assert.equal(h.timers.at(-1)!.ms, 60000);
  h.timers.at(-1)!.fn(); await tick();
  assert.equal(h.requests[1]!.body.get("Status"), "completed"); assert.equal(h.adapter.busy(), false);
});
test("signature matches Twilio published vector and rejects tampering", async () => {
  assert.equal(await twilioSignature("12345", "https://example.com/myapp.php?foo=1&bar=2", new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" })), "L/OH5YylLD5NRKLltdqwSvS0BnU=");
  const h = harness(); await h.adapter.dial("+14155550101");
  assert.equal((await h.callback("answer", { AnsweredBy: "human" }, false)).status, 403);
  assert.equal(await h.adapter.authorizeStream(await h.upgrade()), false);
  assert.equal((await h.callback("status", { CallStatus: "completed", CallSid: "wrong" })).status, 403);
  assert.equal(h.adapter.busy(), true);
});
test("voicemail and unknown AMD outcomes hang up without Gemini", async () => {
  for (const AnsweredBy of ["machine_start", "machine_end_beep", "fax", "unknown", ""]) {
    const h = harness(); await h.adapter.dial("+14155550101");
    assert.match(await (await h.callback("answer", { AnsweredBy })).text(), /Hangup/);
    assert.equal(h.requests[1]!.body.get("Status"), "completed");
    assert.equal(h.connections.length, 0); assert.equal(h.adapter.busy(), false);
  }
});
test("signed stream start binds token and SID, bridges both directions and interruption", async () => {
  const h = harness(); await h.adapter.dial("+14155550101"); const token = await h.answer();
  const socket = new Socket(); await h.adapter.stream(await h.upgrade(), socket);
  socket.emit(start(token)); await tick();
  assert.equal(h.connections.length, 1); assert.match(h.connections[0]!, /key=server-secret/);
  assert.equal(h.gemini.sent[0].setup.systemInstruction.parts[0].text, "Be concise.");
  assert.deepEqual(h.gemini.sent[0].setup.tools, [{ functionDeclarations: [] }]);
  h.gemini.emit({ setupComplete: {} });
  socket.emit({ event: "media", streamSid: "MStest", media: { track: "inbound", payload: encode64(new Uint8Array(160).fill(255)) } }); await tick();
  assert.equal(decode64(h.gemini.sent[1].realtimeInput.audio.data).length, 640);
  assert.equal(h.gemini.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  h.gemini.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: encode64(new Uint8Array(960)) } }] } } });
  assert.equal(decode64(socket.sent[0].media.payload).length, 160);
  assert.equal(socket.sent[0].streamSid, "MStest");
  h.gemini.emit({ serverContent: { interrupted: true } }); assert.equal(socket.sent[1].event, "clear");
  const replay = new Socket(); await h.adapter.stream(await h.upgrade(), replay); replay.emit(start(token)); await tick();
  assert.equal(replay.closed, true); assert.equal(h.connections.length, 1);
  socket.emit({ event: "stop" }); await tick();
  assert.equal(h.adapter.busy(), false); assert.equal(h.gemini.closed, true);
});
test("invalid upgrade, wrong token and wrong SID never reach Gemini", async () => {
  for (const mutation of ["token", "sid"]) {
    const h = harness(); await h.adapter.dial("+14155550101"); const token = await h.answer();
    await assert.rejects(h.adapter.stream(await h.upgrade(false), new Socket()), /Unauthorized/);
    const socket = new Socket(); await h.adapter.stream(await h.upgrade(), socket);
    const message = start(token);
    if (mutation === "token") message.start.customParameters.token = "wrong"; else message.start.callSid = "wrong";
    socket.emit(message); await tick(); assert.equal(socket.closed, true); assert.equal(h.connections.length, 0);
    assert.equal(h.adapter.busy(), true);
  }
});
test("terminal callback closes sockets and permits another call", async () => {
  const h = harness(); await h.adapter.dial("+14155550101"); const token = await h.answer();
  const socket = new Socket(); await h.adapter.stream(await h.upgrade(), socket); socket.emit(start(token)); await tick();
  assert.equal((await h.callback("status", { CallStatus: "completed" })).status, 204);
  assert.equal(socket.closed, true); assert.equal(h.gemini.closed, true); assert.equal(h.requests.length, 1);
  await h.adapter.dial("+14155550101"); assert.equal(h.requests.length, 2);
});
test("uncertain REST failure holds call slot until signed terminal reconciliation", async () => {
  const h = harness({ fetch: async () => { throw new Error("lost response"); } });
  await assert.rejects(h.adapter.dial("+14155550101"), /lost response/);
  assert.equal(h.adapter.busy(), true); await assert.rejects(h.adapter.dial("+14155550101"), /already active/);
});
test("G.711 known samples and chunk boundaries preserve audio lengths", () => {
  assert.equal(decodeMuLaw(255), 0); assert.equal(decodeMuLaw(127), 0);
  assert.equal(decodeMuLaw(0), -32124); assert.equal(decodeMuLaw(128), 32124);
  assert.equal(encodeMuLaw(0), 255); assert.equal(encodeMuLaw(-32124), 0); assert.equal(encodeMuLaw(32124), 128);
  const up = inputAudio(); assert.equal(up(new Uint8Array(160)).length, 640);
  const pcm = new Uint8Array(960); const whole = outputAudio()(pcm); const down = outputAudio();
  const pieces = [...down(pcm.slice(0, 5)), ...down(pcm.slice(5, 17)), ...down(pcm.slice(17))];
  assert.deepEqual(Uint8Array.from(pieces), whole); assert.equal(whole.length, 160);
});
