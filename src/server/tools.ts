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
 * How every act works, for the persona: the framework's half of the act prompt.
 * The server's read-back is the script; the model's own paraphrase never is.
 */
export const ACT_RULES =
  "Actions (needs a yes): ALWAYS call the action first WITHOUT confirmed. The server answers with a read-back: " +
  "say its `text` to the user exactly as given, word for word, never your own paraphrase, and wait for a clear yes. " +
  "Only after that yes, in the user's next turn, call again with the very same arguments plus confirmed=true. " +
  "If the server says \"Not sent yet\", read its text back and ask again; if it says STOP, stop: tell the user plainly " +
  "it didn't go through and why, and don't call it again.";

const CONFIRMED = {
  type: "boolean" as const,
  description: "Leave out on the first call. Set true only after reading back the server's read-back text word for word and hearing a clear yes.",
};

/** An act's declaration, with `confirmed` added if the dot left it out, so the model knows the field. */
function actDecl(d: ToolDecl): ToolDecl {
  if (d.kind !== "act") return d;
  const p = d.parameters ?? { type: "object" };
  if (p.properties?.confirmed) return d;
  return { ...d, parameters: { ...p, type: "object", properties: { ...p.properties, confirmed: CONFIRMED } } };
}

export type Registry = {
  decls: ToolDecl[];
  kind(name: string): ToolDecl["kind"];
  call(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
  /** One line per tool, so a dot's sense of what it can do never drifts from what it has. */
  capabilities(): string;
};

export async function registry(servers: ToolServer[]): Promise<Registry> {
  const owner = new Map<string, ToolServer>();
  const decls: ToolDecl[] = [];
  for (const s of servers) {
    for (const d of await s.list()) {
      if (owner.has(d.name)) throw new Error(`two tool servers declare ${d.name}`);
      owner.set(d.name, s);
      decls.push(actDecl(d));
    }
  }
  const byName = new Map(decls.map((d) => [d.name, d]));
  return {
    decls,
    kind: (name) => byName.get(name)?.kind ?? "read",
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
      const lines = decls
        .map((d) => {
          const first = d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "");
          const tag =
            d.kind === "act" ? " (action, needs a yes)" : d.kind === "private" ? " (private mode only)" : "";
          return `- ${d.name}${tag}: ${first}`;
        })
        .join("\n");
      return decls.some((d) => d.kind === "act") ? `${lines}\n${ACT_RULES}` : lines;
    },
  };
}
