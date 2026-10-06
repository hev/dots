// Slack as a text surface: @mention the bot in one channel and talk to the
// same dot as the voice screen. Socket Mode, so the host only connects out and
// nothing needs a public URL (a tailnet dot stays on its tailnet).
//
// - Only the configured channel. Everything else is ignored.
// - A thread is a session. After the first @mention, replies in that thread
//   reach the dot without another mention.
// - Slack users map to logins. An unmapped user gets no login, so the server
//   refuses acts, private mode and display tools for them.
// - An act reads back in the thread and runs only on a yes from an allowed
//   user, through the same server-side receipts as the voice screen.
// - "clear" (or "/clear", "new") in a thread makes the dot forget it and start
//   fresh there; a new thread is a new session anyway.

import type { chat } from "../server/chat.ts";
import type { Ctx, Store } from "../server/types.ts";

type Chat = ReturnType<typeof chat>;
export type SlackApi = (method: string, body: Record<string, unknown>) => Promise<Record<string, any>>;

export type SlackOptions = {
  chat: Chat;
  store: Store;
  botToken: string;
  /** xapp- token with connections:write, for Socket Mode. */
  appToken?: string;
  channel: string;
  /** Slack user ID to login. */
  users: Record<string, string>;
  /** Demo mode in Slack too unless set false. */
  demo?: boolean;
  /** Overridable for tests. */
  api?: SlackApi;
  WebSocket?: typeof WebSocket;
  log?: (line: string) => void;
};

export type SlackEvent = {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
};

/** Slack mrkdwn: &, < and > are control characters. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A thread to a session id the policy accepts (hex). */
async function sessionOf(channel: string, thread: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`slack:${channel}:${thread}`));
  return [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function slackApi(token: string, base = "https://slack.com/api"): SlackApi {
  return async (method, body) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
}

export function slack(o: SlackOptions) {
  const api = o.api ?? slackApi(o.botToken);
  const log = o.log ?? (() => {});
  let me: string | null = null;

  async function botUser() {
    if (!me) me = String((await api("auth.test", {})).user_id ?? "");
    return me;
  }

  async function display(channel: string, thread: string, result: unknown) {
    const r = (result ?? {}) as { url?: string; label?: string; title?: string };
    const text = r.url ? `<${r.url}|${esc(r.label ?? r.title ?? r.url)}>` : esc(JSON.stringify(result).slice(0, 2900));
    await api("chat.postMessage", { channel, thread_ts: thread, text, unfurl_links: false });
  }

  /** One Slack event. Returns whether the dot answered. */
  async function handle(e: SlackEvent): Promise<boolean> {
    if (e.channel !== o.channel || !e.user || e.bot_id || e.subtype || !e.ts) return false;
    const bot = await botUser();
    const mention = `<@${bot}>`;
    const thread = e.thread_ts ?? e.ts;
    const live = `thread:${o.channel}:${thread}`;

    if (e.type === "app_mention") {
      await o.store.put(live, true, 7 * 24 * 3600);
    } else if (e.type === "message") {
      // A mention also arrives as a message event; answer it once, as the mention.
      if (!e.thread_ts || (e.text ?? "").includes(mention)) return false;
      if ((await o.store.get(live)) === undefined) return false;
    } else return false;

    const text = (e.text ?? "").replaceAll(mention, "").trim();
    if (!text) return false;
    const ctx: Ctx = { session: await sessionOf(o.channel, thread), who: o.users[e.user] ?? null, demo: o.demo !== false };
    log(`SLACK ${ctx.who ?? e.user} ${text.slice(0, 120)}`);

    if (/^\/?(clear|new)$/i.test(text)) {
      await o.chat.clear(ctx);
      await api("chat.postMessage", { channel: o.channel, thread_ts: thread, text: "Cleared. I've forgotten this thread; start fresh." });
      return true;
    }

    await api("reactions.add", { channel: o.channel, timestamp: e.ts, name: "eyes" });
    let reply: string;
    try {
      reply = await o.chat.turn(ctx, text, {
        onDisplay: (_name, result) => display(o.channel, thread, result),
        onSlow: () => void api("chat.postMessage", { channel: o.channel, thread_ts: thread, text: "Putting that to a sub-agent…" }),
      });
    } catch (err) {
      reply = `Something broke on my side: ${String(err).slice(0, 200)}`;
    }
    await api("chat.postMessage", { channel: o.channel, thread_ts: thread, text: esc(reply), unfurl_links: false });
    await api("reactions.remove", { channel: o.channel, timestamp: e.ts, name: "eyes" });
    return true;
  }

  /** Socket Mode: connect out, ack every envelope at once, handle events, reconnect when Slack says so. */
  async function start(): Promise<void> {
    if (!o.appToken) throw new Error("Socket Mode needs an xapp- app token");
    const WS = o.WebSocket ?? globalThis.WebSocket;
    const open = await slackApi(o.appToken)("apps.connections.open", {});
    if (!open.ok) throw new Error(`apps.connections.open: ${open.error}`);
    const ws = new WS(open.url as string);
    ws.onmessage = (m: MessageEvent) => {
      const msg = JSON.parse(String(m.data)) as { type: string; envelope_id?: string; payload?: { event?: SlackEvent } };
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === "events_api" && msg.payload?.event) {
        handle(msg.payload.event).catch((err) => log(`SLACK error ${String(err)}`));
      }
      if (msg.type === "disconnect") ws.close();
    };
    ws.onclose = () => {
      log("SLACK socket closed, reconnecting");
      setTimeout(() => start().catch((err) => log(`SLACK reconnect failed ${String(err)}`)), 2000);
    };
  }

  return { handle, start };
}
