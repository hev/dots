// Haiku: a dot writes them itself (it can open every fresh session with one,
// through the theme's greeting, and write one whenever asked), and this puts it
// on screen as a card the theme styles (`.card.haiku`). Only the shape is
// checked here; HAIKU_CRAFT goes in the persona.

import { defineTool, type Tool } from "../server/index.ts";

export const HAIKU_CRAFT = `- Haiku: three lines, about 5, 7 and 5 syllables. One concrete image, a season word, a small turn in the last line. Plain words, no rhyme, no title. Make it about their real day when you can (something on the calendar, the weather, a win).`;

export function haikuTools(o: { title: string; tz: string; who?: string }): Tool[] {
  return [
    defineTool({
      name: "show_haiku",
      kind: "display",
      description: `Put a haiku on ${o.who ? `${o.who}'s` : "the"} screen: three lines. Use it to open a session, and whenever asked for a haiku about anything. Then say it aloud, slowly.`,
      parameters: {
        type: "object",
        properties: {
          lines: { type: "array", items: { type: "string" }, description: "Exactly three lines" },
          about: { type: "string", description: "A few words on what it's about, for the card" },
        },
        required: ["lines"],
      },
      run: (a) => {
        const lines = (Array.isArray(a.lines) ? a.lines : String(a.lines ?? "").split(/\n|\s\/\s/)).map((l) => String(l).trim()).filter(Boolean);
        if (lines.length !== 3) return { error: `a haiku has three lines; this had ${lines.length}` };
        if (lines.some((l) => l.length > 60)) return { error: "a line that long isn't a haiku line; keep each short" };
        const day = new Date().toLocaleDateString("en-US", { timeZone: o.tz, weekday: "long", month: "long", day: "numeric" });
        return {
          card: {
            title: o.title,
            style: "haiku",
            body: lines.join("\n"),
            subtitle: typeof a.about === "string" && a.about ? `${a.about} · ${day}` : day,
            note: "It's on screen. Say it aloud now, slowly, a breath between lines.",
          },
        };
      },
    }),
  ];
}
