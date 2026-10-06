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
      decls.push(d);
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
      return decls
        .map((d) => {
          const first = d.description.split(/\. (?=[A-Z])/)[0].replace(/\.$/, "");
          const tag =
            d.kind === "act" ? " (action, needs a yes)" : d.kind === "private" ? " (private mode only)" : "";
          return `- ${d.name}${tag}: ${first}`;
        })
        .join("\n");
    },
  };
}
