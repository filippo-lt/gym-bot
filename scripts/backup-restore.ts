import "./load-env.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  isLocalHost,
  parseBackupFile,
  RestoreRefusedError,
  restoreBackup,
} from "../src/backup/restore.js";
import { restoreEnv } from "../src/config/env.js";
import * as schema from "../src/db/schema/index.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowRemote = args.includes("--allow-remote");
const path = args.find((a) => !a.startsWith("--"));

let client: postgres.Sql | undefined;
try {
  if (!path) {
    console.error(
      "Usage: pnpm backup:restore <file.json|file.json.gz> [--dry-run] [--allow-remote]",
    );
    process.exit(1);
  }
  const url = new URL(restoreEnv().RESTORE_DATABASE_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const input = parseBackupFile(readFileSync(path), basename(path));

  const now = new Date();
  const age = (now.getTime() - Date.parse(input.meta.created_at)) / 3_600_000;
  console.log(`target: ${url.hostname}/${database}`);
  console.log(`backup: ${input.meta.created_at} (${age.toFixed(1)} h old)`);
  for (const [name, entry] of Object.entries(input.meta.manifest))
    console.log(`  ${name}: ${entry.rows} rows`);

  if (!isLocalHost(url.hostname) && !allowRemote)
    throw new RestoreRefusedError(
      "remote_not_allowed",
      `${url.hostname} is not a local host. Add --allow-remote to restore there.`,
    );

  client = postgres(url.href, { prepare: false, max: 1, connect_timeout: 10 });
  const summary = await restoreBackup(drizzle(client, { schema }), input, { dryRun, now });
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) console.log("Dry run OK (rolled back). Run again without --dry-run to restore.");
} catch (error) {
  // Message only: a driver error message can carry SQL and row data.
  console.error(
    error instanceof RestoreRefusedError || (error instanceof Error && error.name === "EnvError")
      ? error.message
      : error instanceof Error
        ? `Restore failed (${error.name}).`
        : "Restore failed.",
  );
  process.exitCode = 1;
} finally {
  await client?.end({ timeout: 5 });
}
