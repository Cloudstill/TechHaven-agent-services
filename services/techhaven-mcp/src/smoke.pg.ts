/**
 * live PostgreSQL 门控：DDL + PG 权威 proposal + 并发批准/应用 + 失败关闭。
 * 仅在显式提供 TECHHAVEN_TEST_DB_URL 时运行，不属于默认 mock smoke。
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { PgProposalRepository } from "./proposals/pgStore.js";

const dbUrl = process.env.TECHHAVEN_TEST_DB_URL?.trim() ?? "";
if (!dbUrl) {
  console.error("缺少 TECHHAVEN_TEST_DB_URL；此脚本只用于可清理 schema 的 PostgreSQL 14+ 测试实例");
  process.exit(1);
}

const schema = `th_mcp_${Date.now().toString(36)}`;
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
  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 8,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(ddl);
    check("schema.sql 可在空 schema 执行", true);

    const identity = await pool.query<{ id: string }>(
      `INSERT INTO agent_identities (org_id, name, kind, created_by)
       VALUES (1, 'pg-smoke', 'assistant', 1) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO agent_sessions
         (sid, identity_id, org_id, engine, engine_version, status, started_at)
       VALUES ('sid-pg-smoke', $1, 1, 'mock', '0.1.0', 'running', now())`,
      [identity.rows[0].id],
    );

    const first = new PgProposalRepository(pool, 30, 1);
    const second = new PgProposalRepository(pool, 30, 1);
    const proposal = await first.create({
      sessionId: "sid-pg-smoke",
      orgId: 1,
      tool: "update_ticket_status",
      kind: "task",
      subjectHashId: "task-smoke",
      subjectId: 1,
      fromStatus: "todo",
      toStatus: "doing",
      reason: "live PostgreSQL 并发门控",
    });
    check("PG 权威创建 proposal", (await first.getState(proposal.id)).status === "pending");
    const retried = await second.create({
      sessionId: "sid-pg-smoke",
      orgId: 1,
      tool: "update_ticket_status",
      kind: "task",
      subjectHashId: "task-smoke",
      subjectId: 1,
      fromStatus: "todo",
      toStatus: "doing",
      reason: "live PostgreSQL 并发门控",
    });
    check("同一会话请求重试返回同一 proposal_ref", retried.id === proposal.id);

    const approvals = await Promise.allSettled([
      first.appendEvent("approved", proposal.id, "user:1"),
      second.appendEvent("approved", proposal.id, "user:2"),
    ]);
    check("两个并发批准者只有一个成功", approvals.filter((item) => item.status === "fulfilled").length === 1);

    let domainWrites = 0;
    const apply = async () => {
      domainWrites += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { status: "applied" as const, note: "pg smoke" };
    };
    const applied = await Promise.all([first.applyApproved(proposal.id, apply), second.applyApproved(proposal.id, apply)]);
    check("两个 worker 只有一个执行域写回调", domainWrites === 1 && applied.filter(Boolean).length === 1);
    check("应用终态持久化为 applied", (await first.getState(proposal.id)).status === "applied");

    await pool.end();
    await first.getState(proposal.id).then(
      () => {
        throw new Error("连接池关闭后不应继续接受权威读写");
      },
      () => undefined,
    );
    check("数据库不可用时 proposal 路径失败关闭", true);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main()
  .then(() => console.log(`PG proposal smoke 通过：${checks} 项`))
  .finally(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
