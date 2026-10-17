export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/gymbot_test";

/** Refuses anything that is not a local database whose name ends in `_test`. */
export function assertSafeTestDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL; refusing to run DB tests.");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !name.endsWith("_test")) {
    throw new Error(
      `Refusing to run DB tests against host "${parsed.hostname}" database "${name}": host must be 127.0.0.1 or localhost and the database name must end in _test.`,
    );
  }
  return url;
}

export const testDatabaseUrl = (): string =>
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
