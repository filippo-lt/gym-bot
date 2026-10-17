import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { requireCronAuth } from "../src/http/auth.js";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

export async function GET(request: Request): Promise<Response> {
  try {
    const denied = requireCronAuth(request);
    if (denied) return denied;
  } catch {
    console.error("health: invalid cron environment");
    return Response.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch (error) {
    console.error("health: database check failed, code:", errorCode(error));
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
