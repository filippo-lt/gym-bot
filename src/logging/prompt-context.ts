import { and, desc, eq, gte, ne, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { setsText, viewFromSnapshot } from "../bot/log-format.js";
import { getSession } from "../bot/session.js";
import { logGroups } from "../db/schema/log.js";
import { trainingDate } from "../domain/calendar.js";
import { loadCatalog, loadLadder } from "./catalog.js";
import { recentMessages } from "./conversation.js";
import type { Db } from "./db.js";
import { dateLabel, describeAction } from "./describe.js";
import { groupSnapshot } from "./groups.js";
import { activeAliases } from "./memory.js";
import { getOpenPending } from "./pending.js";
import type { PromptContext, PromptStatic } from "./types.js";

/** How many saved logs the model sees, and how far back (or the same training day). */
export const LAST_SAVED_LIMIT = 3;
export const LAST_SAVED_WINDOW_MS = 6 * 3600 * 1000;

/** About 1,500 tokens (SPEC 5.6e). */
export const ALIAS_CHAR_CAP = 6000;

export async function buildPromptStatic(db: Db): Promise<PromptStatic> {
  const [catalog, ladder] = await Promise.all([loadCatalog(db), loadLadder(db)]);
  return {
    catalog: catalog.map((c) => ({
      slug: c.slug,
      name: c.name,
      aliases: c.aliases,
      type: c.type,
      loadBasis: c.loadBasis,
    })),
    hspuLadder: ladder.map((s) => ({ slug: s.slug, name: s.name })),
  };
}

export async function buildPromptContext(
  db: Db,
  chatId: number,
  now: Date,
): Promise<PromptContext> {
  const today = trainingDate(now);
  const dateText = DateTime.fromISO(today, { zone: "utc" })
    .setLocale("en")
    .toFormat("ccc d LLL yyyy");
  const session = await getSession(db, today);

  let todayLabel: string;
  let todayItems: PromptContext["todayItems"] = [];
  if (session.kind === "session") {
    todayLabel = `${dateText} · Week ${session.week} · ${session.phase}`;
    todayItems = session.items.map((i) => ({
      name: i.planName,
      options: i.options.map((o) => ({ slug: o.slug, name: o.name })),
      prescription: i.prescriptionRaw,
      status: i.status,
    }));
  } else if (session.kind === "rest") {
    todayLabel = `${dateText} · rest day`;
  } else if (session.kind === "before_start") {
    todayLabel = `${dateText} · plan starts ${session.startDate}`;
  } else {
    todayLabel = `${dateText} · plan finished`;
  }

  const aliases: PromptContext["aliases"] = [];
  let chars = 0;
  for (const a of await activeAliases(db)) {
    chars += a.alias.length + a.slug.length + a.name.length + 6;
    if (chars > ALIAS_CHAR_CAP) break;
    aliases.push({ said: a.alias, slug: a.slug, name: a.name });
  }

  const since = new Date(now.getTime() - LAST_SAVED_WINDOW_MS);
  const recentGroups = await db
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(
      and(
        ne(logGroups.source, "import"),
        or(gte(logGroups.performedAt, since), eq(logGroups.sessionDate, today)),
      ),
    )
    .orderBy(desc(logGroups.performedAt), desc(logGroups.id))
    .limit(LAST_SAVED_LIMIT);
  const lastSaved: PromptContext["lastSaved"] = [];
  for (const g of recentGroups) {
    const snap = await groupSnapshot(db, g.id);
    if (!snap) continue;
    lastSaved.push({
      summary: `${snap.exercise.name} ${setsText(viewFromSnapshot(snap))}`,
      sessionDate: dateLabel(snap.sessionDate),
    });
  }

  const open = await getOpenPending(db, chatId, now);
  return {
    todayLabel,
    todayItems,
    aliases,
    pending: open
      ? { summary: open.actions.map(describeAction).join("; "), awaitingEdit: open.awaitingEdit }
      : null,
    lastSaved,
    recent: await recentMessages(db, chatId, now),
  };
}
