import { PostgresRepository } from "@agent-gateway/db";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for migrations");
}

const repo = new PostgresRepository(process.env.DATABASE_URL);
await repo.migrate();
await repo.pool.end();
console.log("migrations applied");
