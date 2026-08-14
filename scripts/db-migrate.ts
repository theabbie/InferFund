import { migrateProductionDatabase } from "../src/lib/db/migrate";

migrateProductionDatabase()
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
