// Reads the running build from git at startup. Node only (child_process), so it
// lives outside src/server, which runs anywhere fetch does. On Workers, pass the
// commit in at build time instead: `{ commit, short, built }`.

import { execFileSync } from "node:child_process";
import type { Version } from "../server/types.ts";

/** The checked-out commit of `cwd` (default: where the process started), or undefined outside a git checkout. `built` is now. */
export function gitVersion(cwd: string = process.cwd()): Version | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return undefined;
    return { commit, short: commit.slice(0, 7), built: new Date().toISOString() };
  } catch {
    return undefined;
  }
}
