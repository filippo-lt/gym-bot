import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCatalog } from "../../src/backup/catalog.js";
import { type BuiltBackup, buildBackup } from "../../src/backup/export.js";
import {
  type BackupInput,
  parseBackupFile,
  RestoreRefusedError,
  restoreBackup,
} from "../../src/backup/restore.js";
import { executeActions } from "../../src/logging/execute.js";
import { createPending } from "../../src/logging/pending.js";
import { stageLogSets } from "../../src/logging/resolve.js";
import type { StagedAction } from "../../src/logging/types.js";
import { connect, MON, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
// This file empties every catalog table, so later files get the baseline back.
afterAll(async () => {
  await resetAndSeed(db, sql);
  await sql.end({ timeout: 5 });
});

const NOW = new Date("2026-10-18T17:00:03.120Z");
const LATER = new Date("2026-10-19T17:00:03.120Z");

async function truncateAll() {
  const names = (await readCatalog(db)).map((t) => `"${t.name}"`).join(", ");
  await sql.unsafe(`truncate table ${names} restart identity cascade`);
}

const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;

async function stage(slug: string): Promise<StagedAction> {
  const r = await stageLogSets(
    db,
    {
      exercise: { slug, said: slug },
      sets: { count: 2, reps: 6, load_kg: 55 },
      guessed_fields: [],
      needs_confirmation: false,
    },
    MON,
  );
  if (!r.ok) throw new Error(r.error);
  return r.action;
}

const parse = (b: BuiltBackup): BackupInput =>
  parseBackupFile(new TextEncoder().encode(b.json), "b.json");

let first: BuiltBackup;
let action: StagedAction;
let firstResult: Awaited<ReturnType<typeof executeActions>>;
let pendingId: number;
let pendingResult: Awaited<ReturnType<typeof executeActions>>;

beforeAll(async () => {
  await resetAndSeed(db, sql);
  action = await stage("bench_press");
  firstResult = await executeActions(db, "u:100", [action], { now: MON });
  const { pending } = await createPending(db, {
    chatId: 4242,
    kind: "confirm",
    actions: [await stage("face_pull")],
    reasons: ["guessed"],
    sourceUpdateId: 7,
    now: MON,
  });
  pendingId = pending.id;
  pendingResult = await executeActions(db, `p:${pending.id}`, pending.actions, {
    pendingId: pending.id,
    now: MON,
  });
  await sql`insert into usage_logs (date, model, input_tokens, output_tokens) values ('2026-10-18', 'm', 10, 5)`;
  await sql`insert into class_logs (date, raw_text, parsed, heavy_groups, source)
    values ('2026-10-15', null, '{"moves": [{"n": "row", "w": 20.5}]}'::jsonb, '{pull,legs}', 'bot'),
           ('2026-10-08', 'text', 'null'::jsonb, '{}', 'bot')`;
  first = await buildBackup(db, NOW);
});

describe("restoreBackup", () => {
  it("dry run changes nothing", async () => {
    await truncateAll();
    const summary = await restoreBackup(db, parse(first), { dryRun: true, now: LATER });
    expect(summary.dryRun).toBe(true);
    expect(summary.backupAgeHours).toBe(24);
    expect(summary.inserted.write_ledger).toBeGreaterThan(0);
    for (const t of await readCatalog(db)) expect(await count(t.name), t.name).toBe(0);
  });

  it("restores every table byte for byte", async () => {
    const summary = await restoreBackup(db, parse(first), { dryRun: false, now: LATER });
    expect(summary.dryRun).toBe(false);
    const second = await buildBackup(db, NOW);
    for (const [name, entry] of Object.entries(first.meta.manifest)) {
      if (name === "user_state") {
        expect(second.meta.manifest[name]?.rows).toBe(entry.rows);
        continue;
      }
      expect(second.meta.manifest[name], name).toEqual(entry);
    }
    expect(await count("inbox")).toBe(0);
    expect(await count("chat_lease")).toBe(0);
  });

  it("continues ids past every restored id", async () => {
    const { pending } = await createPending(db, {
      chatId: 4242,
      kind: "confirm",
      actions: [await stage("face_pull")],
      reasons: [],
      sourceUpdateId: 8,
      now: MON,
    });
    expect(pending.id).toBeGreaterThan(pendingId);
    const maxGroup = (await sql`select max(id)::int as m from log_groups`)[0]?.m as number;
    const done = await executeActions(db, "u:200", [await stage("bench_press")], { now: MON });
    expect(done.status).toBe("done");
    const [g] = await sql`select max(id)::int as m from log_groups`;
    expect(g?.m).toBeGreaterThan(maxGroup);
  });

  it("keeps the ledger: a restored source key writes nothing", async () => {
    const groups = await count("log_groups");
    const entries = await count("log_entries");
    const retry = await executeActions(db, "u:100", [action], { now: MON });
    expect(retry).toEqual(firstResult);
    const again = await executeActions(db, `p:${pendingId}`, [await stage("face_pull")], {
      pendingId,
      now: MON,
    });
    expect(again).toEqual(pendingResult);
    expect(await count("log_groups")).toBe(groups);
    expect(await count("log_entries")).toBe(entries);
  });
});

describe("restore refusals", () => {
  const refusal = async (input: BackupInput) => {
    try {
      await restoreBackup(db, input, { dryRun: false, now: LATER });
    } catch (e) {
      if (e instanceof RestoreRefusedError) return e.reason;
      throw e;
    }
    return undefined;
  };

  it("refuses a target that has plan rows", async () => {
    await resetAndSeed(db, sql);
    expect(await refusal(parse(first))).toBe("target_not_empty");
  });

  it("refuses a different migration list", async () => {
    await truncateAll();
    const input = parse(first);
    input.meta = { ...input.meta, migrations: [...input.meta.migrations, "extra"] };
    expect(await refusal(input)).toBe("schema_mismatch");
    expect(await count("plans")).toBe(0);
  });

  it("refuses an extra table or an unknown column", async () => {
    const extra = parse(first);
    extra.tables.ghost = [];
    extra.meta.manifest.ghost = { rows: 0, sha256: "x" };
    expect(await refusal(extra)).toBe("schema_mismatch");

    const col = parse(first);
    (col.tables.plans as Record<string, unknown>[])[0] = { nope: 1 };
    expect(await refusal(col)).toBe("schema_mismatch");
  });

  it("refuses an edited row and leaves the target empty", async () => {
    const input = parse(first);
    const plans = input.tables.plans as Record<string, unknown>[];
    plans[0] = { ...plans[0], name: `${String(plans[0]?.name)} edited` };
    expect(await refusal(input)).toBe("manifest_mismatch");
    for (const t of await readCatalog(db)) expect(await count(t.name), t.name).toBe(0);
  });
});
