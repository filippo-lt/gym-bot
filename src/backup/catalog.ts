import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/** Transient or lock-only tables that a restore point does not need. */
export const EXCLUDED_TABLES = ["chat_lease", "inbox"] as const;

export interface CatalogTable {
  name: string;
  /** In ordinal order. */
  columns: string[];
  primaryKey: string[];
  /** Other tables this one has a foreign key to (self references dropped). */
  dependsOn: string[];
  /** Serial/identity columns and their sequence (schema-qualified, as Postgres prints it). */
  sequences: { column: string; sequence: string }[];
}

/** Anything with `execute`: the Drizzle db or one of its transactions. */
export type Queryable = Pick<Db, "execute">;

/** Public base tables, sorted by name. One query at a time (session pooler). */
export async function readCatalog(db: Queryable): Promise<CatalogTable[]> {
  const cols = await db.execute(sql`
    select c.relname as "table", a.attname as "column",
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as sequence
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname, a.attnum`);
  const pks = await db.execute(sql`
    select c.relname as "table", a.attname as "column"
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(k.conkey) with ordinality as u(attnum, ord)
    join pg_attribute a on a.attrelid = c.oid and a.attnum = u.attnum
    where n.nspname = 'public' and k.contype = 'p'
    order by c.relname, u.ord`);
  const fks = await db.execute(sql`
    select c.relname as "table", p.relname as parent
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class p on p.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_namespace pn on pn.oid = p.relnamespace
    where k.contype = 'f' and n.nspname = 'public' and pn.nspname = 'public'`);

  const tables = new Map<string, CatalogTable>();
  for (const r of cols) {
    const name = String(r.table);
    let t = tables.get(name);
    if (!t) {
      t = { name, columns: [], primaryKey: [], dependsOn: [], sequences: [] };
      tables.set(name, t);
    }
    t.columns.push(String(r.column));
    if (r.sequence) t.sequences.push({ column: String(r.column), sequence: String(r.sequence) });
  }
  for (const r of pks) tables.get(String(r.table))?.primaryKey.push(String(r.column));
  for (const r of fks) {
    const t = tables.get(String(r.table));
    const parent = String(r.parent);
    if (t && parent !== t.name && !t.dependsOn.includes(parent)) t.dependsOn.push(parent);
  }
  for (const t of tables.values()) t.dependsOn.sort();
  return [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Parents first (stable by name). Parents outside the list are ignored. Throws on a cycle. */
export function restoreOrder(tables: CatalogTable[]): CatalogTable[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const sorted = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const done = new Set<string>();
  const out: CatalogTable[] = [];
  while (out.length < sorted.length) {
    const next = sorted.find(
      (t) =>
        !done.has(t.name) &&
        t.dependsOn.every((d) => d === t.name || !byName.has(d) || done.has(d)),
    );
    if (!next) throw new Error("Foreign key cycle between tables: cannot order a restore.");
    done.add(next.name);
    out.push(next);
  }
  return out;
}

/** Migration hashes from Drizzle's table, in id order. */
export async function readMigrations(db: Queryable): Promise<string[]> {
  const rows = await db.execute(sql`select hash from drizzle.__drizzle_migrations order by id`);
  return rows.map((r) => String(r.hash));
}
