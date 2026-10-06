// A dot's theme: everything about how it looks, sounds and greets its person,
// as data, so the person can restyle it out loud (see ../restyle) and a restyle
// can only ever change this. `screenOptions(theme)` turns it into the screen's
// options; the dot's own server chains the rest (cues, icons, art).

import type { Palette, ScreenOptions, Sound } from "../client/index.ts";
import type { CueKind } from "../cues/index.ts";

export type Theme = {
  slug: string;
  /** One line the person would recognise: "sakura: cherry blossoms on a spring sky". */
  about: string;
  /** A Gemini Live prebuilt voice. */
  voice: string;
  /** How the voice should be: a few sentences the persona gets. */
  personality: string;
  /** Sent when a fresh session is ready, e.g. open with a haiku. */
  greeting: string;
  /** Direction for the spoken cues' TTS. */
  cueStyle: string;
  cues: Record<CueKind, string[]>;
  /** Words on the tool chips. */
  labels: Record<string, string>;
  palette: { light: Palette; dark: Palette };
  /** Versioned paths, so a phone drops a cached icon when the art changes. */
  icons: { any192: string; any512: string; maskable512: string; apple: string };
  /** The manifest's background colour: the icon's ground. */
  color: string;
  sounds: ScreenOptions["sounds"] & {};
  design: NonNullable<ScreenOptions["design"]>;
  /** The haiku card's small heading. */
  haikuTitle: string;
};

export type { Palette, Sound };

/** The screen options a theme decides. Spread them into screenRoutes with the dot's name, user, packs and install. */
export function screenOptions(t: Theme): Pick<ScreenOptions, "labels" | "theme" | "design" | "sounds" | "greeting" | "cues"> {
  return { labels: t.labels, theme: t.palette, design: t.design, sounds: t.sounds, greeting: t.greeting, cues: true };
}
