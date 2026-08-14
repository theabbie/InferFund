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

let client: postgres.Sql | undefined;
let db: Database | undefined;

export function getDb(): Database {
  if (db) return db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. See .env.example for setup instructions.",
    );
  }
  client = postgres(connectionString, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  db = drizzlePostgres(client, { schema });
  return db;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  return drizzlePglite(pglite, { schema });
}

export async function closeDbForTests(): Promise<void> {
  if (client) {
    await client.end({ timeout: 1 });
    client = undefined;
    db = undefined;
  }
}

export { schema };
