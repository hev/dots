# Contributing

dots is early and shaped by the dots that run on it. Issues and small pull
requests are welcome; for anything larger, open an issue first so we can say
whether it fits.

## What fits

The framework is the harness, not the tools: what two dots both need belongs
here, and what only one needs stays in that dot's repo. A dot's persona, tools
and renderers stay in its own repo.

- The core is fetch-based: no Node or Workers APIs in `src/server`. State goes
  through `Store`, traces through `TraceSink`, identity through `Identity`.
- Policy lives on the server. Don't move a check into the client or the prompt.
- A dot with no retrieval backend must still work.

## Checks

Node 22.18 or later runs the TypeScript directly. Before every pull request:

```sh
npm ci
npm test
npm run check
```

CI runs the same. `scripts/uat preview` is the browser acceptance check (it
needs Playwright); see the README's Develop section.

## Licence

dots is Apache-2.0. By contributing you agree your contribution is licensed
under it (section 5 of the [LICENSE](LICENSE)).
