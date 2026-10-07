# dots

The open framework behind hev dot and twc's talk mode. Design note:
https://linear.app/hevmind/document/hevdots-design-note-1fdf19d68d31 (Linear
project **hev dot**). This is the `dots` line: new work goes on the DOT team,
judged against [MISSION.md](MISSION.md). Earlier issues stay on FAC (extraction
is FAC-59, the Layer adapter FAC-60).

- The core is fetch-based: no Node or Workers APIs in `src/server`. State goes
  through `Store`, traces through `TraceSink`, identity through `Identity`.
- The framework is the harness, not the tools. A dot's persona, tools and
  renderers stay in its own repo. Never copy hev mind or client specifics here.
- Policy lives on the server. Don't move a check into the client or the prompt.
- Layer is the default source, not a requirement: a dot with no Layer
  namespaces must still work.
- `npm test` and `npm run check` before every commit.
