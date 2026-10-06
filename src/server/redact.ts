// Bar-safe: nothing secret or client-identifying reaches the model. Ported
// from hev dot's safe()/private(). Secrets and contact details always go;
// amounts go too in bar-safe mode.

const SECRETS: [RegExp, string][] = [
  [/op:\/\/[^\s'"`)]+/g, "op://•••"],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|hv|lyr|tskey)[-_][A-Za-z0-9_-]{10,}/gi, "•••key•••"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "•••key•••"],
  [/([?&](?:k|key|token|access_token|sig|signature|auth|code)=)[^&\s'"]+/gi, "$1•••"],
  [
    /\b(authorization|bearer|x-api-key|api[_-]?key|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s'",}]{6,}/gi,
    "$1$2•••",
  ],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "•••jwt•••"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "•••"],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "•••@•••"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "•.•.•.•"],
];

const MONEY = /(?<![\w])\$\s?\d[\d,]*(?:\.\d+)?\s?[KkMmBb]?\b/g;

/** Keys whose values are handles, not content, and must pass through untouched. */
const KEEP = new Set(["id", "k"]);

export type RedactOptions = {
  /** Real name to codename, e.g. a client the dot mustn't name in public. */
  codenames?: Record<string, string>;
  /** Extra patterns, e.g. a home directory. */
  extra?: [RegExp, string][];
};

export type Redactor = {
  /** Secrets, contact details and codenames. Always applied. */
  safe<T>(x: T): T;
  /** safe() plus amounts. Applied in bar-safe mode. */
  barsafe<T>(x: T): T;
  /** "Real is Codename; ..." for the persona, so the dot can map names it hears. */
  codebook(): string;
};

export function redactor(opts: RedactOptions = {}): Redactor {
  const codenames = opts.codenames ?? {};
  const keys = Object.keys(codenames).sort((a, b) => b.length - a.length);
  const names = keys.length
    ? new RegExp(`(?<![A-Za-z])(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z])`, "g")
    : null;
  const rules = [...SECRETS, ...(opts.extra ?? [])];

  const walk = (x: unknown, f: (s: string) => string): unknown => {
    if (typeof x === "string") return f(x);
    if (Array.isArray(x)) return x.map((v) => walk(v, f));
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, KEEP.has(k) ? v : walk(v, f)]));
    }
    return x;
  };
  const scrub = (s: string) => {
    for (const [rx, sub] of rules) s = s.replace(rx, sub);
    return names ? s.replace(names, (m) => codenames[m]) : s;
  };

  return {
    safe: <T>(x: T) => walk(x, scrub) as T,
    barsafe: <T>(x: T) => walk(x, (s) => scrub(s).replace(MONEY, "$$•••")) as T,
    codebook() {
      const seen = new Map<string, [string, string]>();
      for (const [k, v] of Object.entries(codenames)) if (!seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), [k, v]);
      return [...seen.values()].map(([k, v]) => `${k} is ${v}`).join("; ");
    },
  };
}
