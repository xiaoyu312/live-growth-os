import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("db:migrate 必须配置 DATABASE_URL");

const applied = await runMigrations(databaseUrl);
console.log(applied.length ? `已应用迁移：${applied.join(", ")}` : "数据库迁移已是最新版本");
