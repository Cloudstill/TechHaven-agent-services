/** live PostgreSQL 门控：多实例配额、事件幂等、权威恢复与中断收敛。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { MockDriver } from "./drivers/mock.js";
import { GatewayPgStore, PgQuotaError } from "./pgStore.js";
import { SessionRegistry } from "./sessions.js";

const dbUrl = process.env.TECHHAVEN_TEST_DB_URL?.trim() ?? "";
if (!dbUrl) {
  console.error("缺少 TECHHAVEN_TEST_DB_URL；此脚本只用于可清理 schema 的 PostgreSQL 14+ 测试实例");
  process.exit(1);
}

const schema = `th_gateway_${Date.now().toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), "techhaven-gateway-pg-"));
const admin = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 5_000 });
let checks = 0;

function check(label: string, condition: unknown): void {
  if (!condition) throw new Error(`✗ ${label}`);
  checks += 1;
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const ddl = readFileSync(new URL("../../../docs/agent-db/schema.sql", import.meta.url), "utf8");
  const ddlPool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` });
  await ddlPool.query(ddl);
  await ddlPool.end();
  check("schema.sql 可供 Gateway 权威存储使用", true);

  const first = await GatewayPgStore.connect(dbUrl, schema);
  const second = await GatewayPgStore.connect(dbUrl, schema);
  const now = new Date().toISOString();
  const creates = await Promise.allSettled([
    first.createSession({ sid: "sid-a", orgId: 7, createdAt: now }, 1),
    second.createSession({ sid: "sid-b", orgId: 7, createdAt: now }, 1),
  ]);
  check("多实例并发创建受 PG advisory lock 配额约束", creates.filter((item) => item.status === "fulfilled").length === 1);
  check(
    "配额失败返回明确 PgQuotaError",
    creates.some((item) => item.status === "rejected" && item.reason instanceof PgQuotaError),
  );
  const sid = creates[0].status === "fulfilled" ? "sid-a" : "sid-b";
  const running = { type: "status_change" as const, seq: 1, ts: new Date().toISOString(), status: "running" as const };
  check("首条事件提交 PG", await first.appendEvent(sid, running));
  const duplicate = await Promise.all([first.appendEvent(sid, running), second.appendEvent(sid, running)]);
  check(
    "重复 sid+seq 无重复副作用",
    duplicate.every((inserted) => inserted === false),
  );
  await first.close();
  await second.close();

  const restoredStore = await GatewayPgStore.connect(dbUrl, schema);
  const restored = await restoredStore.restore(0);
  check("PG 恢复同一 session 与完整事件", restored.length === 1 && restored[0].sid === sid && restored[0].events.length === 1);

  const registry = await SessionRegistry.open(new MockDriver(), {
    dataDir,
    maxSessionsPerOrg: 1,
    sessionRetentionMinutes: 0,
    sessionIdleTimeoutMinutes: 0,
    pgStore: restoredStore,
  });
  const record = registry.get(sid);
  check(
    "Gateway 重启把不可恢复活动会话原子收敛为 failed",
    record?.status === "failed" && record.events.length === 2 && record.events[1].seq === 2,
  );
  await registry.dispose();

  const verifyPool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` });
  const verified = await verifyPool.query<{ status: string; event_count: string }>(
    `SELECT s.status, count(e.id)::text AS event_count
       FROM agent_sessions s JOIN agent_events e ON e.session_id = s.id
      WHERE s.sid = $1 GROUP BY s.status`,
    [sid],
  );
  await verifyPool.end();
  check("恢复终态及事件已写入 PG 权威表", verified.rows[0]?.status === "failed" && verified.rows[0]?.event_count === "2");
}

main()
  .then(() => console.log(`Gateway PG smoke 通过：${checks} 项`))
  .finally(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
