import { defineConfig } from "drizzle-kit";
import "./scripts/load-env.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  throw new Error("MIGRATION_DATABASE_URL is not set (session pooler, port 5432).");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
