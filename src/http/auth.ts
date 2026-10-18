import { timingSafeEqual } from "node:crypto";
import { cronEnv } from "../config/env.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function hasValidBearer(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^bearer (.+)$/i.exec(header);
  return match?.[1] !== undefined && safeEqual(match[1], secret);
}

export function hasValidSecretHeader(request: Request, header: string, secret: string): boolean {
  const value = request.headers.get(header);
  return value !== null && safeEqual(value, secret);
}

export function requireCronAuth(request: Request): Response | null {
  if (hasValidBearer(request, cronEnv().CRON_SECRET)) return null;
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
