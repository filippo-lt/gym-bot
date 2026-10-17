import "./load-env.js";
import { runMigrations } from "../src/db/migrate.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set (session pooler, port 5432).");
  process.exit(1);
}

const applied = await runMigrations(url);
console.log(
  applied
    ? "Migrations applied."
    : "No migrations found (drizzle/meta/_journal.json missing). Nothing to do.",
);
