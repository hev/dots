// The sub-agent: a slower, stronger text model the fast voice hands a question
// to when it needs judgment (a budget, a trend, "can I afford it"). It works the
// question through the dot's own read tools and answers in a few spoken
// sentences, which come back to the voice like any slow tool's result. It can't
// act or show: only read and private tools are offered, and every call still
// goes through dot.invoke, so demo mode, logins and redaction hold.

import type { ChatModel, Msg } from "./chat.ts";
import type { Registry } from "./tools.ts";
import type { Ctx } from "./types.ts";

export type SubagentOptions = {
  /** The thinking model, e.g. geminiChat({ apiKey, model: "gemini-3.1-pro-preview" }). */
  model: ChatModel;
  /** Tool name. Default "deep_think". */
  name?: string;
  /** What to send it, for the voice: "budgets, trends, whether he can afford something". */
  when?: string;
  /** Tool rounds before it must answer. Default 16. */
  maxSteps?: number;
};

const RULES = `You are the thinking sub-agent. The fast voice handed you this question because it needs judgment
and more looking-up than a voice turn allows. Use the tools as much as you need: pull several months, compare
periods, check categories and merchants. Every number you give comes from a tool; never guess one. Then answer in
under 120 words of plain sentences for the voice to say aloud: the answer first, then the evidence in a phrase or
two, then the one thing worth doing. No lists, no markdown. You can't change anything; if the answer is an action,
say what the voice should offer to do.`;

export function thinkDecl(o: SubagentOptions) {
  return {
    name: o.name ?? "deep_think",
    kind: "slow" as const,
    description:
      `Hand a question that needs judgment to the thinking sub-agent, which looks things up across the tools and reasons it through${o.when ? `. USE IT for: ${o.when}` : ""}. ` +
      "Write a self-contained question with the period and anything he said. Takes a minute or so; say you're putting it to a sub-agent, then carry on. The answer comes back to you when it lands.",
    parameters: {
      type: "object" as const,
      properties: { question: { type: "string" as const, description: "The whole question, self-contained." } },
      required: ["question"],
    },
  };
}

export async function think(
  o: SubagentOptions,
  question: string,
  ctx: Ctx,
  deps: {
    tools: Registry;
    persona: string;
    invoke: (name: string, args: Record<string, unknown>, ctx: Ctx) => Promise<{ status: number; body: unknown }>;
  },
): Promise<{ answer: string } | { error: string }> {
  const decls = deps.tools.decls.filter((d) => (d.kind ?? "read") === "read" || d.kind === "private");
  const open = new Set(decls.map((d) => d.name));
  const history: Msg[] = [{ role: "user", text: question }];
  const system = `${deps.persona}\n\n${RULES}`;
  const steps = o.maxSteps ?? 16;
  for (let step = 0; step < steps; step++) {
    // On the last round, no tools: it has to answer with what it has.
    const out = await o.model.turn({ system, history, tools: step === steps - 1 ? [] : decls });
    history.push({ role: "model", text: out.text, calls: out.calls, raw: out.raw });
    if (!out.calls?.length) return out.text ? { answer: out.text } : { error: "the sub-agent came back empty" };
    const results = [];
    for (const c of out.calls) {
      const result = open.has(c.name) ? (await deps.invoke(c.name, c.args, ctx)).body : { error: `${c.name} isn't open to the sub-agent` };
      results.push({ id: c.id, name: c.name, result });
    }
    history.push({ role: "tool", results });
  }
  return { error: "the sub-agent ran out of steps" };
}
