import type { Ctx, Tool, ToolDecl, ToolServer } from "./types.ts";

export function defineTool(tool: Tool): Tool {
  return tool;
}

/** Tools that run in this process. */
export function local(tools: Tool[]): ToolServer {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    async list() {
      return tools.map(({ run: _run, ...decl }) => decl);
    },
    async call(name, args, ctx) {
      const t = byName.get(name);
      if (!t) return { error: `unknown tool ${name}` };
      return t.run(args, ctx);
    },
  };
}

/**
 * Tools served over HTTP, in any language. The contract is hev dot's
 * `/api/tool`: POST `{name, args, safe, session}`, answer with JSON.
 * Declarations are passed in, since a tool server needn't list itself.
 */
export function http(opts: {
  url: string;
  tools: ToolDecl[];
  headers?: (ctx: Ctx) => Record<string, string>;
}): ToolServer {
  return {
    async list() {
      return opts.tools;
    },
    async call(name, args, ctx) {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers?.(ctx) ?? {}) },
        body: JSON.stringify({ name, args, safe: ctx.demo, session: ctx.session }),
      });
      if (!res.ok) return { error: `tool server answered ${res.status}` };
      return res.json();
    },
  };
}

/**
 * How approvals work, for the persona: the framework's half of the act prompt.
 * The server holds the call; the user approves it on the card or out loud.
 */
export const ACT_RULES =
  "Tools marked (needs a yes): call the tool once, with the arguments you mean. The server applies the user's own " +
  "approval setting. If it answers `pending_approval`, an approval card with Approve, Always approve and Cancel is now " +
  "on the user's screen: say in one short sentence what is waiting (use its `summary`) and stop. Don't call the tool " +
  "again. If the user then clearly says yes to it out loud, call confirm_action with that approval's `id`; never " +
  "without hearing a yes, and never in the same breath as the tool call. If a tool is refused by the user's " +
  "settings, say so plainly and don't retry.";

/** The tool a spoken yes goes through. Framework-owned: no tool server may declare it. */
export const CONFIRM = "confirm_action";

export const CONFIRM_DECL: ToolDecl = {
  name: CONFIRM,
  kind: "act",
  description:
    "Approve one pending approval, only after the user clearly said yes to it out loud. Runs the held call once, with the arguments on the card.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The `id` from the pending_approval the server answered." } },
    required: ["id"],
  },
};

/** One line per tool: what it does, and what it needs. `approval` says each tool's current setting. */
export function capabilityLines(decls: ToolDecl[], approval: (name: string) => string = () => "always"): string {
  const lines = decls
    .filter((d) => d.name !== CONFIRM)
    .map((d) => {
      const first = d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "");
      const a = approval(d.name);
      const tag = a === "ask" ? " (needs a yes)" : a === "deny" ? " (refused by the user's settings)" : d.kind === "private" ? " (private mode only)" : "";
      return `- ${d.name}${tag}: ${first}`;
    })
    .join("\n");
  return decls.some((d) => d.name !== CONFIRM && approval(d.name) === "ask") ? `${lines}\n${ACT_RULES}` : lines;
}

/** An act declared for the old read-back flow keeps its `confirmed` field out of the model's view: approval is the server's now. */
function withoutConfirmed(d: ToolDecl): ToolDecl {
  if (!d.parameters?.properties?.confirmed) return d;
  const { confirmed: _c, ...properties } = d.parameters.properties;
  const required = d.parameters.required?.filter((r) => r !== "confirmed");
  return { ...d, parameters: { ...d.parameters, properties, ...(required ? { required } : {}) } };
}

export type Registry = {
  decls: ToolDecl[];
  kind(name: string): ToolDecl["kind"];
  call(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
  /** One line per tool, so a dot's sense of what it can do never drifts from what it has. Acts ask, by default. */
  capabilities(): string;
};

export async function registry(servers: ToolServer[]): Promise<Registry> {
  const owner = new Map<string, ToolServer>();
  const decls: ToolDecl[] = [];
  for (const s of servers) {
    for (const d of await s.list()) {
      if (d.name === CONFIRM) throw new Error(`${CONFIRM} is the framework's own tool`);
      if (owner.has(d.name)) throw new Error(`two tool servers declare ${d.name}`);
      owner.set(d.name, s);
      decls.push(withoutConfirmed(d));
    }
  }
  const byName = new Map(decls.map((d) => [d.name, d]));
  return {
    decls,
    // confirm_action runs a held call, so it's an act: only allowed logins, never offered to the sub-agent.
    kind: (name) => (name === CONFIRM ? "act" : byName.get(name)?.kind ?? "read"),
    async call(name, args, ctx) {
      const s = owner.get(name);
      if (!s) return { error: `unknown tool ${name}` };
      try {
        return await s.call(name, args, ctx);
      } catch (e) {
        return { error: String(e).slice(0, 300) };
      }
    },
    capabilities() {
      return capabilityLines(decls, (n) => (byName.get(n)?.kind === "act" ? "ask" : "always"));
    },
  };
}
