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
 * - private: refused in bar-safe mode.
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

export type Ctx = {
  session: string;
  /** The verified login, or null when the identity adapter can't say who it is. */
  who: string | null;
  barsafe: boolean;
};

export type Tool = ToolDecl & {
  run(args: Record<string, unknown>, ctx: Ctx): unknown | Promise<unknown>;
};

/** Where tools come from: in-process, an HTTP tool server, or MCP. */
export type ToolServer = {
  list(): Promise<ToolDecl[]>;
  call(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
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
