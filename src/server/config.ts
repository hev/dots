// The user's settings for a dot: its identity and look, its system prompt, which
// tools it has and what each needs before it runs, and its sources. The
// configurator reads and writes them through GET/PUT /api/config; only an
// allowed login can, never a tool call. They're read on every turn, so a change
// takes effect on the next turn or session without a restart.

import type { Approval, DotConfig, DotIdentity, Source, StoredConfig, ToolDecl, ToolSetting } from "./types.ts";

/** What the dot's author sets as the defaults the user starts from (and resets to). */
export type ConfigDefaults = {
  identity?: Partial<DotIdentity>;
  /** The dot's own instructions, shown in the configurator and given to the model with the persona. */
  systemPrompt?: string;
  /** Per-tool defaults over the framework's: acts "ask", everything else "always". */
  tools?: Record<string, Partial<ToolSetting>>;
  sources?: Source[];
};

export const APPROVALS: readonly Approval[] = ["ask", "always", "deny"];

/** The framework's default for a tool: an act asks first; anything else just runs. */
export function defaultSetting(d: ToolDecl): ToolSetting {
  return { enabled: true, approval: d.kind === "act" ? "ask" : "always" };
}

/** Every field filled in: the author's defaults, then what the user stored. Unknown tools in the store are dropped. */
export function effective(name: string, decls: ToolDecl[], defaults: ConfigDefaults, stored: StoredConfig = {}): DotConfig {
  const identity: DotIdentity = { name, icon: "", theme: "", voice: "", model: "", ...defined(defaults.identity), ...defined(stored.identity) };
  const tools: Record<string, ToolSetting> = {};
  for (const d of decls) tools[d.name] = { ...defaultSetting(d), ...defined(defaults.tools?.[d.name]), ...defined(stored.tools?.[d.name]) };
  return {
    identity,
    systemPrompt: stored.systemPrompt ?? defaults.systemPrompt ?? "",
    tools,
    sources: stored.sources ?? defaults.sources ?? [],
  };
}

function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type PatchLimits = {
  /** Registered tool names; a patch can't name any other. */
  tools: Set<string>;
  /** chatModels ids; `identity.model` must be one, or empty for the dot's default. */
  models: Set<string>;
  /** The voices the dot offers; when given, `identity.voice` must be one, or empty. */
  voices?: string[];
  /** The author's default prompt: storing it again is the same as a reset. */
  defaultPrompt: string;
};

const VOICE = /^[A-Za-z0-9 _.-]{0,40}$/;
const COLOR = /^(#[0-9a-f]{3,8})?$/i;
const SAFE_NAME = /^[^<>\n\r]{1,60}$/;
const MAX_PROMPT = 20_000;
const MAX_SOURCES = 50;
const MAX_SOURCE_BYTES = 4_000;

/** An icon is a root-relative path or an https URL; the screen draws it as an <img>. Empty means the plain dot. */
function iconOk(s: string): boolean {
  if (s === "") return true;
  if (s.length > 2000 || /["'<>\s]/.test(s)) return false;
  if (/^\/(?!\/)/.test(s)) return true;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks a PUT body and folds it into what's stored. Fields left out stay as they were;
 * `systemPrompt: null` resets the prompt to the dot's default. Answers a string saying what's wrong
 * rather than keeping half a change.
 */
export function applyPatch(stored: StoredConfig, body: unknown, l: PatchLimits): StoredConfig | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "send a JSON object";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["identity", "systemPrompt", "tools", "sources"].includes(k));
  if (extra.length) return `unknown field ${extra[0]}`;
  const next: StoredConfig = { ...stored };

  if (b.identity !== undefined) {
    if (!b.identity || typeof b.identity !== "object" || Array.isArray(b.identity)) return "identity must be an object";
    const id: Partial<DotIdentity> = { ...stored.identity };
    for (const [k, v] of Object.entries(b.identity as Record<string, unknown>)) {
      if (!["name", "icon", "theme", "voice", "model"].includes(k)) return `unknown identity field ${k}`;
      if (typeof v !== "string") return `identity.${k} must be a string`;
      const s = v.trim();
      if (k === "name" && !SAFE_NAME.test(s)) return "name must be 1 to 60 characters, on one line";
      if (k === "icon" && !iconOk(s)) return "icon must be an https URL or a path on this site";
      if (k === "theme" && !COLOR.test(s)) return "theme must be a hex color like #e25822";
      if (k === "voice" && (!VOICE.test(s) || (l.voices && s && !l.voices.includes(s)))) return `voice ${s} isn't offered`;
      if (k === "model" && s && !l.models.has(s)) return `model ${s} isn't offered`;
      id[k as keyof DotIdentity] = s;
    }
    next.identity = id;
  }

  if (b.systemPrompt !== undefined) {
    if (b.systemPrompt === null) delete next.systemPrompt;
    else if (typeof b.systemPrompt !== "string") return "systemPrompt must be a string, or null to reset it";
    else if (b.systemPrompt.length > MAX_PROMPT) return `systemPrompt is over ${MAX_PROMPT} characters`;
    else if (b.systemPrompt === l.defaultPrompt) delete next.systemPrompt;
    else next.systemPrompt = b.systemPrompt;
  }

  if (b.tools !== undefined) {
    if (!b.tools || typeof b.tools !== "object" || Array.isArray(b.tools)) return "tools must be an object of tool name to setting";
    const tools: Record<string, Partial<ToolSetting>> = { ...stored.tools };
    for (const [name, v] of Object.entries(b.tools as Record<string, unknown>)) {
      if (!l.tools.has(name)) return `no tool called ${name}`;
      if (!v || typeof v !== "object" || Array.isArray(v)) return `tools.${name} must be an object`;
      const t: Partial<ToolSetting> = { ...tools[name] };
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "enabled") {
          if (typeof x !== "boolean") return `tools.${name}.enabled must be true or false`;
          t.enabled = x;
        } else if (k === "approval") {
          if (!APPROVALS.includes(x as Approval)) return `tools.${name}.approval must be ask, always or deny`;
          t.approval = x as Approval;
        } else return `unknown tool setting ${k}`;
      }
      tools[name] = t;
    }
    next.tools = tools;
  }

  if (b.sources !== undefined) {
    if (!Array.isArray(b.sources)) return "sources must be a list";
    if (b.sources.length > MAX_SOURCES) return `up to ${MAX_SOURCES} sources`;
    for (const s of b.sources) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return "each source must be an object";
      if (JSON.stringify(s).length > MAX_SOURCE_BYTES) return `a source is over ${MAX_SOURCE_BYTES} bytes`;
    }
    next.sources = JSON.parse(JSON.stringify(b.sources)) as Source[];
  }
  return next;
}
