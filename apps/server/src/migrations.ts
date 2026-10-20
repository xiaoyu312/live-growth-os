import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDirectory = fileURLToPath(new URL("../../../infra/migrations/", import.meta.url));
const migrationFilePattern = /^\d+_[a-z0-9_]+\.sql$/;
const migrationLockId = 734_208_051;

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  const appliedNow: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`SELECT pg_advisory_lock(${migrationLockId})`;
    try {
      const files = (await readdir(migrationsDirectory)).filter((file) => migrationFilePattern.test(file)).sort();
      for (const file of files) {
        const migrationSql = await readFile(`${migrationsDirectory}${file}`, "utf8");
        const checksum = createHash("sha256").update(migrationSql).digest("hex");
        const [existing] = await sql<Array<{ version: string; checksum: string }>>`
          SELECT version, checksum FROM schema_migrations WHERE version = ${file}`;
        if (existing) {
          if (existing.checksum !== checksum) throw new Error(`已应用迁移的校验和不一致：${file}`);
          continue;
        }
        const body = migrationTransactionBody(migrationSql);
        await sql.begin(async (transaction) => {
          await transaction.unsafe(body);
          await transaction`INSERT INTO schema_migrations (version, checksum) VALUES (${file}, ${checksum})`;
        });
        appliedNow.push(file);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${migrationLockId})`;
    }
    return appliedNow;
  } finally {
    await sql.end();
  }
}

export function migrationTransactionBody(source: string): string {
  return source.replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
}
