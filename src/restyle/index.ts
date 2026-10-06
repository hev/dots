// A person redecorates their own dot, out loud. restyle hands the change to a
// factory session (an agent with the image skills), which builds a new theme in
// theme/ and web/ and opens a PR; the screen polls until it's up. ship_theme,
// after a yes, checks the PR touches only theme/ and web/, that the theme code
// is only theme (no Node, no processes, no network), runs the tests on the
// merge, merges it, pulls and restarts the dot. Anything else waits for the
// repo's owner on GitHub. Ported from hev dot's improve_self and ship_self.
//
// The dot's repo follows the shape in hev/dasha's AGENTS.md ("Themes"):
// theme/index.ts exports a Theme (../theme), scripts/icons.py cuts icons,
// scripts/preview.ts renders the screen without keys, deploy/run.sh restarts it.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool, type Tool } from "../server/index.ts";

/** Runs a command and resolves with stdout; rejects with the tail of stderr. */
export type Sh = (bin: string, args: string[], o?: { cwd?: string; timeout?: number }) => Promise<string>;

export const BRIEF = (who: string, change: string) => `Restyle ${who}'s dot, asked for out loud by ${who}:

${change}

You are changing only how the dot looks, sounds and greets ${who}: theme/ and web/, nothing else. Read AGENTS.md
("Themes") first. It's a voice assistant on ${who}'s phone, built on ../dots; theme/index.ts is the contract.

- Archive the current theme first: copy theme/index.ts and theme/design.ts to theme/past/<current slug>/ (fix their
  relative imports there), so ${who} can come back to it.
- Make it delightful, and true to what ${who} asked. Change whatever fits: palette (light and dark, text at
  4.5:1 on paper), fonts (Google Fonts only), decor and the design script, earcon notes, cue lines and cueStyle,
  the greeting, the personality, chip labels, the haiku card's title, even the voice if ${who} asked for one.
- New art with the nano-banana skill. The app icon is always ${who}, from web/icon-v1-512.png as the
  reference, restyled for the theme: one round icon on a flat colour ground, legible at 60px. Cut it with
  scripts/icons.py into new versioned names (the next free vN; never overwrite old ones) and point theme.icons and
  theme.color at them. Decor images go in web/theme/ (png, jpg, webp or svg) and are served at /theme/<file>.
- Theme code is only data, CSS, HTML and browser JS: no node: imports, no process, no require, no fetch on the server,
  imports only from ./ inside theme/ or the dots client types. ship_theme refuses anything else.
- npm test && npm run check must pass. Look at it: run it locally (AGENTS.md says how) and screenshot it with the
  browser-use skill in light and dark at phone size, and fix anything ugly or unreadable.
- Open one PR. Its first description line is one plain sentence the dot can read aloud to ${who}, starting
  "Your dot can now look like" or similar. Put the screenshots in the PR. Don't deploy: the dot ships it after a yes.`;

const FILES = /^(theme|web)\//;
/** A theme file may import its siblings, theme/index.ts, and the dots screen's and theme's types. */
const ALLOWED = [/^\.\/[\w.-]+\.ts$/, /^(\.\.\/)+index\.ts$/, /^(\.\.\/)+dots\/src\/(client|theme)\/index\.ts$/];
const FORBIDDEN = /\bnode:|child_process|\bprocess\.|\brequire\s*\(|\bimport\s*\(|\bDeno\b|\bBun\b|\beval\s*\(|new\s+Function/;

/** What in these theme sources isn't just theme, or [] when it's clean. */
export function themeProblems(sources: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(sources)) {
    // The whole file, browser script included: a \${} in a template string runs on the server.
    const bad = src.match(FORBIDDEN);
    if (bad) out.push(`${file} uses ${bad[0]}`);
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm))
      if (!ALLOWED.some((r) => r.test(m[1] ?? m[2]!))) out.push(`${file} imports ${m[1] ?? m[2]}`);
  }
  return out;
}

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** `repo` is OWNER/NAME on GitHub; `who` is the person's name; `repoDir` is the running checkout. */
export function restyleTools(o: { sh: Sh; repo: string; who: string; repoDir: string; pollMs?: number; maxMs?: number }): Tool[] {
  const REPO = o.repo, who = o.who;
  const { sh } = o;
  const gh = (args: string[]) => sh("gh", args, { timeout: 60_000 });
  return [
    defineTool({
      name: "restyle",
      kind: "slow",
      description:
        `Redecorate ${who}'s dot as described: a new look, colours, art, sounds, greeting or voice ("make it German", "autumn in Kyoto", "go back to the last one"). An agent builds it and opens a change to approve; it takes about ten minutes. Nothing changes until a yes to ship_theme.`,
      parameters: { type: "object", properties: { change: { type: "string", description: "What was asked for, in their words, with any details given" } }, required: ["change"] },
      run: async (a) => {
        const change = String(a.change ?? "").trim();
        if (!change) return { error: "say what the new look should be" };
        const out = await sh("factory", ["run", REPO, BRIEF(who, change)], { timeout: 120_000 });
        const id = out.trim().split("\n").pop()?.match(/\b([a-z0-9]{6})\b/)?.[1];
        if (!id) return { error: "the agent didn't start: " + out.slice(-200) };
        const until = Date.now() + (o.maxMs ?? 28 * 60_000);
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, o.pollMs ?? 20_000));
          const s = (JSON.parse(await sh("factory", ["ls", "--all", "--json"])) as { id: string; status: string; pr?: { number?: number } }[]).find((x) => x.id === id);
          if (!s) continue;
          if (s.pr?.number) {
            const pr = JSON.parse(await gh(["pr", "view", String(s.pr.number), "-R", REPO, "--json", "title,body,url"])) as { title: string; body: string; url: string };
            return { pr: s.pr.number, says: (pr.body || pr.title).trim().split("\n")[0], session: id,
              note: "The new look is ready to ship. Read its first line, delightedly, and ask if they'd like it; on a yes, call ship_theme with this pr." };
          }
          if (s.status !== "running")
            return { error: "the agent stopped without a new look", latest: (await sh("factory", ["peek", id, "-n", "6"])).slice(-500), session: id };
        }
        return { working: true, session: id, note: "It's taking longer than usual. Say it's still being painted, and you'll know when it's done next time they ask." };
      },
    }),
    defineTool({
      name: "ship_theme",
      kind: "act",
      description: "Ship a new look restyle made: checks it, merges it and restarts the dot, which blinks off for a few seconds. Read back what the new look is and get a yes first.",
      parameters: { type: "object", properties: { pr: { type: "integer", description: "The number restyle gave" }, confirmed: { type: "boolean" } }, required: ["pr"] },
      run: async (a) => {
        const n = Number(a.pr);
        if (!Number.isInteger(n) || n < 1) return { error: "need the number restyle gave" };
        const pr = JSON.parse(await gh(["pr", "view", String(n), "-R", REPO, "--json", "state,files,title,url"])) as { state: string; files: { path: string }[]; title: string; url: string };
        if (pr.state !== "OPEN") return { error: `that change is ${pr.state.toLowerCase()}, not open` };
        const outside = pr.files.map((f) => f.path).filter((p) => !FILES.test(p));
        if (outside.length) return { error: "this change reaches past the theme, so the repo's owner ships it on GitHub", files: outside.slice(0, 5), open: pr.url };
        if ((await sh("git", ["-C", o.repoDir, "status", "--porcelain", "--untracked-files=no"])).trim())
          return { error: "someone is working in the dot's checkout on the mini, so I won't ship over them" };
        const tmp = join(dirname(o.repoDir), `${REPO.split("/")[1]}-ship-${process.pid}`);
        const git = (args: string[], cwd = o.repoDir) => sh("git", ["-C", cwd, ...args], { timeout: 60_000 });
        await git(["worktree", "remove", "--force", tmp]).catch(() => {});
        await git(["fetch", "-q", "--force", "origin", "main", `pull/${n}/head:refs/ship/${n}`]);
        await git(["worktree", "add", "--detach", tmp, "origin/main"]);
        try {
          await git(["-c", `user.name=${REPO.split("/")[1]}`, "-c", "user.email=hevbot@hevmind.ai", "merge", "--no-edit", "-q", `refs/ship/${n}`], tmp);
          const problems = themeProblems(Object.fromEntries(tsFiles(join(tmp, "theme")).map((f) => [f.slice(tmp.length + 1), readFileSync(f, "utf8")])));
          if (problems.length) return { error: "the new theme has code that isn't just theme, so the repo's owner looks at it first", why: problems.slice(0, 4), open: pr.url };
          await sh("ln", ["-s", join(o.repoDir, "node_modules"), join(tmp, "node_modules")]);
          await sh("npm", ["test"], { cwd: tmp, timeout: 180_000 }).catch((e) => Promise.reject(new Error("the tests fail on it: " + String(e).slice(-300))));
          await sh("npm", ["run", "check"], { cwd: tmp, timeout: 180_000 }).catch((e) => Promise.reject(new Error("it doesn't typecheck: " + String(e).slice(-300))));
        } finally {
          await git(["worktree", "remove", "--force", tmp]).catch(() => {});
        }
        await gh(["pr", "merge", String(n), "-R", REPO, "--squash", "--delete-branch"]);
        await git(["pull", "-q", "--ff-only"]);
        // Restart from outside this process: run.sh kills the tmux session the dot runs in.
        spawn("zsh", ["-lc", `sleep 3; cd ${o.repoDir} && deploy/run.sh >> /tmp/${REPO.split("/")[1]}-redeploy.log 2>&1`], { detached: true, stdio: "ignore" }).unref();
        return { shipped: pr.title, restarting: "in a few seconds",
          note: "Say it's shipped, with joy, and that you'll blink off for a moment; the new look appears after a reload and a tap." };
      },
    }),
  ];
}
