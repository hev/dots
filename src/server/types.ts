// The contract every dot is built from. No Node or Workers APIs here: a dot
// runs wherever `fetch(Request) => Response` does.

/** JSON Schema, the subset tool parameters need. Speech adapters translate it. */
export type JSONSchema = {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: (string | number)[];
};

/**
 * - read: answers a question. The default.
 * - act: changes something. Runs only after a read-back and a matching yes.
 * - private: refused in demo mode.
 * - display: the result goes to the screen; the model hears only `{shown: true}`.
 * - slow: returns a job handle at once; the client polls and hands the result back.
 */
export type Kind = "read" | "act" | "private" | "display" | "slow";

export type ToolDecl = {
  name: string;
  description: string;
  parameters?: JSONSchema;
  kind?: Kind;
};

/**
 * What a display tool returns as `{ card }`: the screen draws it, and the model
 * hears only that it's up, plus `note` if there is one. A link is a plain https
 * URL, so on a phone it opens the app that owns it (Maps, YouTube Music...).
 */
export type Card = {
  title: string;
  subtitle?: string;
  lines?: { k: string; v: string }[];
  /** Served by the dot or a public URL; never one carrying a key. */
  image?: { src: string; alt: string };
  link?: { url: string; label: string };
  /** Free text under the title, line breaks kept: a poem, a note. */
  body?: string;
  /** A class name for the dot's own CSS, e.g. "haiku". */
  style?: string;
  /** A button that opens one of the screen's apps (see ScreenOptions.apps) over the chat. */
  app?: { name: string; label: string };
  /** For the model only: what to say about the card now that it's up. */
  note?: string;
};

/**
 * Which build is running: the full commit, a short form for display, and when it
 * was built (ISO 8601). `semver` (e.g. "1.4.0") is the dot's own release, shown
 * on the screen's tag in place of the sha; the sha stays in info and the log.
 */
export type Version = { commit: string; short: string; built: string; semver?: string };

export type Ctx = {
  session: string;
  /** The verified login, or null when the identity adapter can't say who it is. */
  who: string | null;
  demo: boolean;
  /** The user turn a call belongs to, set by surfaces that know their turns (the chat loop). Act receipts use it. */
  turn?: string;
};

export type Tool = ToolDecl & {
  run(args: Record<string, unknown>, ctx: Ctx): unknown | Promise<unknown>;
};

/** Where tools come from: in-process, an HTTP tool server, or MCP. */
export type ToolServer = {
  list(): Promise<ToolDecl[]>;
  call(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
};

/**
 * A pack: one integration a dot plugs in whole (maps, a bank, a calendar). The
 * tools go through the same policy as any other; routes serve what the tools
 * hand the screen (a map image, say) so keys stay on the server; guidance is a
 * few lines the persona gets about using them; labels name them on the chips.
 */
export type Pack = {
  name: string;
  tools: ToolServer;
  routes?: (req: Request) => Response | null | Promise<Response | null>;
  guidance?: string;
  labels?: Record<string, string>;
};

/** Says who is on the other end of a request, e.g. a Tailscale login or a Clerk user. */
export type Identity = (req: Request) => Promise<string | null>;

/** A key-value store with expiry. Memory on Node, KV or a Durable Object on Workers. */
export type Store = {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
};

/** One line of a dot trace, the format hev kit indexes as harness `dot`. */
export type TraceLine = {
  session_id: string;
  id: string;
  ts: string | number | null;
  role: "user" | "assistant" | "event";
  text: string;
  model?: string | null;
  /** On the session-start line: the build that served the session. */
  version?: Version;
  tool_calls?: {
    id: string;
    name: string;
    args: unknown;
    result: string;
    is_error: boolean;
    duration_ms: number | null;
  }[];
};

export type TraceSink = (session: string, lines: TraceLine[]) => Promise<void>;

/** What a speech provider gets to lock into a session server-side. */
export type SessionSetup = {
  persona: string;
  tools: ToolDecl[];
};

export type VoiceProvider = {
  name: string;
  /** Mint a short-lived, single-session credential with the setup locked in. */
  mint(setup: SessionSetup): Promise<Record<string, unknown>>;
};
