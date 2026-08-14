import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzlePostgres<typeof schema>>;
export type TestDatabase = ReturnType<typeof drizzlePglite<typeof schema>>;

export type AnyDatabase = PgDatabase<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  typeof schema
> & {
  $client?: unknown;
};

const globalRegistry = globalThis as unknown as {
  __inferfundDb?: AnyDatabase;
  __inferfundPgClient?: postgres.Sql;
};

export function getDb(): AnyDatabase {
  const db = globalRegistry.__inferfundDb;
  if (db) return db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. See .env.example for setup instructions.",
    );
  }
  const sqlClient = postgres(connectionString, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const created = drizzlePostgres(sqlClient, { schema });
  globalRegistry.__inferfundPgClient = sqlClient;
  globalRegistry.__inferfundDb = created;
  return created;
}

export function setDbForTests(testDb: AnyDatabase): void {
  globalRegistry.__inferfundDb = testDb;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  return drizzlePglite(pglite, { schema });
}

export async function closeDbForTests(): Promise<void> {
  const client = globalRegistry.__inferfundPgClient;
  if (client) {
    await client.end({ timeout: 1 });
    globalRegistry.__inferfundPgClient = undefined;
    globalRegistry.__inferfundDb = undefined;
  }
}

export { schema };
