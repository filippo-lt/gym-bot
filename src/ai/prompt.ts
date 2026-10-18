import type { PromptContext, PromptStatic } from "../logging/types.js";
import type { TextBlockParam } from "./model.js";

const RULES = `You are GymBot's intent parser for one user's Telegram workout log.

Rules:
- You only parse intent and phrase short replies. Code does all math, unit conversion and saving. Never compute numbers.
- Write tools (log_sets, edit_last_entry, undo_last_entry) only STAGE an action. After staging, end your turn with NO text: the bot shows its own summary.
- Never state a number that is not in a tool result or the context below.
- Use short, simple English (the user is not a native speaker), but reply in the user's language.
- For questions about today's plan or what is done, call get_session and answer from its result.
- There are no suggested loads yet. If asked, say that is not available yet.
- If the message is not about training, answer in one short line and call no tool.
- One log_sets call per exercise. A bare correction of a saved log ("no it was 22.5", "rir 3") is edit_last_entry. "undo" is undo_last_entry.
- Omit day unless the user named one. Use day "today" only when the user says it was today or rejects an earlier day.
- A correction of the NEWEST log under "Last saved logs" (the first one listed; "no it was 18") is edit_last_entry when no request is pending, never a new log_sets. edit_last_entry cannot reach older logs: tell the user you can't change that log yet.
- When an unsaved request is pending, corrections restate it with log_sets; edit_last_entry and undo_last_entry act only on saved logs.
- Pass what the user said; list anything you filled in yourself in guessed_fields.
- When the exercise is unclear, call log_sets with only exercise.said (no slug): the bot then asks with buttons. Never ask about the exercise in text.
- Plain text only: no Markdown (no **, __, #, backticks).
- If a tool returns an error, fix the input and call again, or ask the user one short question.`;

function catalogText(s: PromptStatic): string {
  const lines = s.catalog.map(
    (e) =>
      `${e.slug} · ${e.name} · ${e.aliases.length ? e.aliases.join(", ") : "-"} · ${e.type} · ${e.loadBasis ?? "-"}`,
  );
  const ladder = s.hspuLadder.map((h, i) => `${i + 1}. ${h.slug} · ${h.name}`);
  return `Exercise catalog (slug · name · aliases · type · load basis):\n${lines.join("\n")}\n\nHSPU ladder (easiest to hardest):\n${ladder.join("\n")}`;
}

export function buildStaticText(s: PromptStatic): string {
  return `${RULES}\n\n${catalogText(s)}`;
}

export function buildDynamicText(ctx: PromptContext): string {
  const parts: string[] = [`Today: ${ctx.todayLabel}`];
  if (ctx.todayItems.length) {
    parts.push(
      `Today's items:\n${ctx.todayItems
        .map((i) => {
          const opts =
            i.options.length > 1 ? ` [options: ${i.options.map((o) => o.slug).join(" | ")}]` : "";
          return `- ${i.name}${opts} · ${i.prescription} · ${i.status}`;
        })
        .join("\n")}`,
    );
  } else {
    parts.push("Today's items: none");
  }
  if (ctx.aliases.length) {
    parts.push(
      `User aliases:\n${ctx.aliases.map((a) => `- "${a.said}" = ${a.slug} (${a.name})`).join("\n")}`,
    );
  }
  if (ctx.pending) {
    parts.push(
      `Pending request awaiting the user's confirmation: ${ctx.pending.summary}${
        ctx.pending.awaitingEdit
          ? "\nThe user is editing this pending request: restate the full corrected set of actions."
          : ""
      }`,
    );
  }
  if (ctx.lastSaved.length) {
    parts.push(
      `Last saved logs (newest first):\n${ctx.lastSaved
        .map((l) => `- ${l.summary} (session ${l.sessionDate})`)
        .join("\n")}`,
    );
  }
  if (ctx.recent.length) {
    parts.push(`Recent messages:\n${ctx.recent.map((m) => `${m.role}: ${m.text}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildSystem(s: PromptStatic, ctx: PromptContext): TextBlockParam[] {
  return [
    { type: "text", text: buildStaticText(s), cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDynamicText(ctx) },
  ];
}
