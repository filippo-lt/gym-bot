export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/gymbot_test";

export const testDatabaseUrl = (): string =>
  process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
