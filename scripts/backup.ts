import "./load-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFiles, buildBackup } from "../src/backup/export.js";
import { closeDb, getDb } from "../src/db/client.js";

const now = new Date();
try {
  const built = await buildBackup(getDb(), now);
  const files = backupFiles(built, now, { allowGzip: false });
  mkdirSync("backups", { recursive: true });
  for (const f of [files.json, files.zip]) {
    const path = join("backups", f.name);
    writeFileSync(path, f.data);
    console.log(`${path} (${(f.data.length / 1024).toFixed(1)} KB)`);
  }
} finally {
  await closeDb();
}
