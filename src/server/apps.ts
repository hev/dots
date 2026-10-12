import { defineTool, local } from "./tools.ts";
import type { ToolServer } from "./types.ts";

/**
 * The tools that open and close the screen's apps by voice: `open_app` and
 * `close_app`, both display tools, so the screen acts on them and the model
 * hears only that it's done. `apps` maps each app's name (as given to
 * `screenRoutes({ apps })`) to a line telling the model when to open it.
 */
export function appTools(apps: Record<string, string>): ToolServer {
  const names = Object.keys(apps);
  return local([
    defineTool({
      name: "open_app",
      kind: "display",
      description: `Opens one of the app's views over the chat; the conversation carries on. Apps: ${names.map((n) => `${n} (${apps[n]})`).join("; ")}.`,
      parameters: { type: "object", properties: { app: { type: "string", enum: names, description: "Which app to open." } }, required: ["app"] },
      run: (a) => {
        const app = String(a.app ?? "");
        return names.includes(app) ? { app, note: `The ${app} app is open over the chat.` } : { error: `no app called ${app}` };
      },
    }),
    defineTool({
      name: "close_app",
      kind: "display",
      description: "Closes the open app and goes back to the chat. Use when the user says to close it, go back or that they're done with it.",
      run: () => ({ close_app: true }),
    }),
  ]);
}
