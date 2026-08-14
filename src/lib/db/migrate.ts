import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { getDb, type Database, type TestDatabase } from "./client";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export async function migrateProductionDatabase(): Promise<void> {
  await migratePostgres(getDb() as Database, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}

export async function migrateTestDatabase(db: TestDatabase): Promise<void> {
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
