import { and, desc, eq, sql } from "drizzle-orm";
import { memoryItems } from "../db/schema/agent.js";
import { exercises } from "../db/schema/plan.js";
import type { Db, Q } from "./db.js";

export function normalizeAlias(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface MemoryItem {
  id: number;
  kind: "alias" | "preference" | "limitation" | "weekly_summary";
  content: string;
  structured: Record<string, unknown> | null;
  confirmed: boolean;
  active: boolean;
  createdAt: Date;
}

export interface AliasRow {
  id: number;
  alias: string;
  exerciseId: number;
  slug: string;
  name: string;
}

/** Saves "said" -> exercise. Replaces any active alias with the same normalized text. */
export async function saveAlias(
  db: Db,
  said: string,
  exerciseId: number,
): Promise<{ item: MemoryItem; alias: string } | null> {
  const alias = normalizeAlias(said);
  if (!alias) return null;
  return db.transaction(async (tx) => {
    const [ex] = await tx.select().from(exercises).where(eq(exercises.id, exerciseId));
    if (!ex) throw new Error(`Unknown exercise id ${exerciseId}`);
    await tx
      .update(memoryItems)
      .set({ active: false })
      .where(
        and(
          eq(memoryItems.kind, "alias"),
          eq(memoryItems.active, true),
          sql`${memoryItems.structured}->>'alias' = ${alias}`,
        ),
      );
    const [item] = await tx
      .insert(memoryItems)
      .values({
        kind: "alias",
        content: `"${said.trim()}" = ${ex.name}`,
        structured: { alias, exerciseId: ex.id, slug: ex.slug },
        confirmed: true,
      })
      .returning();
    return { item: item as MemoryItem, alias };
  });
}

export async function deactivateMemory(db: Q, id: number): Promise<boolean> {
  const rows = await db
    .update(memoryItems)
    .set({ active: false })
    .where(and(eq(memoryItems.id, id), eq(memoryItems.active, true)))
    .returning({ id: memoryItems.id });
  return rows.length > 0;
}

/** Active items only, newest first. */
export async function listMemory(db: Q): Promise<MemoryItem[]> {
  return (await db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.active, true))
    .orderBy(desc(memoryItems.id))) as MemoryItem[];
}

export async function activeAliases(db: Q): Promise<AliasRow[]> {
  const rows = await listMemory(db);
  const out: AliasRow[] = [];
  for (const r of rows) {
    if (r.kind !== "alias" || !r.structured) continue;
    const s = r.structured as { alias?: string; exerciseId?: number; slug?: string };
    if (!s.alias || s.exerciseId === undefined || !s.slug) continue;
    const [ex] = await db
      .select({ name: exercises.name })
      .from(exercises)
      .where(eq(exercises.id, s.exerciseId));
    if (!ex) continue;
    out.push({ id: r.id, alias: s.alias, exerciseId: s.exerciseId, slug: s.slug, name: ex.name });
  }
  return out;
}
