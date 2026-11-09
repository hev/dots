# dots marketing site

- Never use ChatGPT Sites. Adam authorized Cloudflare Pages deployment to hevdots.com and hev.dev/dots.
- Do not invoke the Sites plugin or add Sites hosting configuration.
- The site is static HTML/CSS in `dist/`; open `dist/index.html` directly to preview.
- Follow https://hevmind.com/brand for typography, layout, naming, and voice.
- Artwork uses layered colored-paper portraits, matching hev me and dasha dot. Use the nano-banana Gemini image skill for new art.
- Story dot is not built yet; label it as a concept.
- Canonical URL: https://hevdots.com/. The same page is mirrored at https://hev.dev/dots/.
- Cloudflare Pages project: `hevdots` (production branch `main`). Export only the public allowlist with `node marketing/bin/export.mjs /tmp/hevdots-public` from the dots repo.
- Update the mirror by exporting to the hev-dev repo's `dots/`, then run its `bin/build` and deploy `dist/`. Never deploy a repository root.
- Legacy Cloudflare Pages upload currently requires Wrangler; cf's `pages deploy` command explicitly does not support it. Use the authenticated project deployment flow, never ChatGPT Sites.
- The framework repository is public at https://github.com/hev/dots under Apache-2.0 (since 2026-11-09). Point people to the README's "Try it with no keys" section to start. Nothing is published to npm, so don't imply an install.
- Every page carries the hevkit.com-style `hev/dots` GitHub link with a star count in the header, and the PostHog snippet guarded to `hevdots.com` and `hev.dev`. Both live in `dist/index.html`; the generator copies the head into the other pages.

- Case-study pages are generated with `node marketing/bin/build-cases.mjs`; rerun after changing shared home-page navigation or case-study copy in the generator.
- Screenshots in `assets/screens/` show the real app frontends with staged sample content, not live private account data. Keep that distinction in their captions.
- Inbox copy should describe connected email intake and mail tools. The framework exposes inbox information; it does not provision mailboxes by itself.
