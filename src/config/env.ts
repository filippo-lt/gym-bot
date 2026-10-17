import { type ZodType, z } from "zod";

export class EnvError extends Error {
  constructor(group: string, issues: string[]) {
    super(`Invalid ${group} environment:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvError";
  }
}

function loadGroup<T>(
  group: string,
  schema: ZodType<T>,
  source: NodeJS.ProcessEnv = process.env,
): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "(env)";
    return `${name}: ${issue.message}`;
  });
  throw new EnvError(group, issues);
}

function memoize<T>(group: string, schema: ZodType<T>): () => T {
  let cached: T | undefined;
  return () => {
    cached ??= loadGroup(group, schema);
    return cached;
  };
}

const strictInt = (fallback: number) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d+$/, "must be a positive whole number")
      .transform(Number)
      .pipe(z.number().int().positive("must be a positive whole number"))
      .default(fallback),
  );

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const requiredString = (name: string) =>
  z.string({ error: "missing" }).min(1, `${name} must not be empty`);

const dbSchema = z.object({
  DATABASE_URL: requiredString("DATABASE_URL"),
  MIGRATION_DATABASE_URL: optionalString,
});

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: requiredString("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_WEBHOOK_SECRET: requiredString("TELEGRAM_WEBHOOK_SECRET"),
  ALLOWED_TELEGRAM_USER_ID: z
    .string({ error: "missing" })
    .regex(/^\d+$/, "must be a positive whole number")
    .transform(Number)
    .pipe(z.number().int().positive("must be a positive whole number")),
});

const aiSchema = z.object({
  ANTHROPIC_API_KEY: requiredString("ANTHROPIC_API_KEY"),
  ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-sonnet-5-5")),
  AI_DAILY_TOKEN_CAP: strictInt(200_000),
  AI_MONTHLY_TOKEN_CAP: strictInt(3_000_000),
});

const sttSchema = z
  .object({
    STT_PROVIDER: z.enum(["groq", "openai"], {
      error: (issue) => (issue.input === undefined ? "missing" : "must be groq or openai"),
    }),
    GROQ_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
  })
  .superRefine((env, ctx) => {
    const keyName = env.STT_PROVIDER === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY";
    if (!env[keyName]) {
      ctx.addIssue({
        code: "custom",
        path: [keyName],
        message: `required when STT_PROVIDER=${env.STT_PROVIDER}`,
      });
    }
  });

const cronSchema = z.object({
  CRON_SECRET: z.string({ error: "missing" }).min(32, "CRON_SECRET must be at least 32 characters"),
});

export const dbEnv = memoize("database", dbSchema);
export const telegramEnv = memoize("telegram", telegramSchema);
export const aiEnv = memoize("ai", aiSchema);
export const sttEnv = memoize("speech-to-text", sttSchema);
export const cronEnv = memoize("cron", cronSchema);
