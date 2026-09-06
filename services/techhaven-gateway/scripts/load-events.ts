/**
 * Agent Trace 落库装载器（R2）：把网关事件 JSONL 批量导入 PostgreSQL（agent-plane schema v0.3）。
 *
 * 用法：
 *   TECHHAVEN_DB_URL=postgres://... npm run load                     # 读 ./data/gateway.jsonl
 *   npm run load -- --file ./data/gateway.jsonl --org 1               # 显式指定文件与组织兜底
 *
 * 映射（详见 README「事件落库」小节的交叉核对表）：
 *   kind:"session" patch 行 → agent_identities / agent_sessions（sid 唯一键 upsert，幂等）
 *   kind:"event"    行     → agent_events（ON CONFLICT (session_id, seq) DO NOTHING，可重跑）
 *   kind:"permission" 行   → 本批不落库（agent_tool_calls 权威台账在 techhaven-mcp），仅计数报告
 *
 * 兼容两种 patch 行形态：早期格式（每次状态变更各写一行 patch，只有 status）与
 * 当前格式（首行 patch 带全量归属字段 orgId/subjectType/subjectId）。旧数据缺 org →
 * 用 --org 兜底并计数警告。
 *
 * 明确标注：本装载器未经 live PostgreSQL 验证（本机无 Docker/PG），SQL 按 schema v0.3 逐列核对。
 */
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";

const { positionals, values } = parseArgs({
  allowPositionals: false,
  options: {
    file: { type: "string" },
    url: { type: "string" },
    org: { type: "string" },
    /** 只跑解析/聚合，不做任何 DB 写入（无 PG 环境验证用） */
    "dry-run": { type: "boolean" },
  },
});

const filePath = values.file ?? "./data/gateway.jsonl";
const dbUrl = values.url ?? process.env.TECHHAVEN_DB_URL ?? "";
const fallbackOrg = Number(values.org ?? "1");
const ENGINE = "techhaven-gateway";
const ENGINE_VERSION = "0.1.0";
const IDENTITY_NAME = "techhaven-gateway";

if (!dbUrl && !values["dry-run"]) {
  console.error("缺少数据库地址：设置 TECHHAVEN_DB_URL 或传 --url（dry-run 模式不需要）");
  process.exit(1);
}
if (!existsSync(filePath)) {
  console.error(`事件文件不存在：${filePath}`);
  process.exit(1);
}

interface PatchRow {
  kind: "session";
  sid: string;
  ts?: string;
  patch: { status?: string; orgId?: number; ownerActor?: string; subjectType?: string; subjectId?: string; note?: string };
}
interface EventRow {
  kind: "event";
  sid: string;
  event: { type: string; seq: number; ts: string; [k: string]: unknown };
}
interface PermissionRow {
  kind: "permission";
  sid: string;
  requestId?: string;
  decision?: string;
  ts?: string;
}
type Row = PatchRow | EventRow | PermissionRow;

/** 每会话的文件序聚合状态（含新旧格式兼容） */
interface SessionAgg {
  ownerActor?: string;
  sid: string;
  orgId: number; // 第一个 patch 行提供，否则兜底
  orgFromPatch: boolean;
  status: string;
  firstTs?: string;
  lastTs?: string;
  /** 首个 status_change: running 事件的 ts（started_at 优先来源） */
  runningTs?: string;
  /** 末个终态 status_change 事件的 ts（ended_at 优先来源） */
  terminalTs?: string;
  note?: string;
  events: EventRow["event"][];
}

async function main(): Promise<void> {
  const bySid = new Map<string, SessionAgg>();
  let totalLines = 0;
  let parseFailures = 0;
  let permissionRows = 0;

  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }) });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;
    let row: Row;
    try {
      row = JSON.parse(trimmed) as Row;
    } catch {
      parseFailures++;
      continue;
    }
    if (row.kind === "permission") {
      permissionRows++;
      continue;
    }
    if (!row.sid) {
      parseFailures++;
      continue;
    }
    let agg = bySid.get(row.sid);
    if (!agg) {
      agg = { sid: row.sid, orgId: fallbackOrg, orgFromPatch: false, status: "queued", events: [] };
      bySid.set(row.sid, agg);
    }
    if (row.kind === "session") {
      if (typeof row.patch.ownerActor === "string" && /^user:[1-9]\d*$/.test(row.patch.ownerActor))
        agg.ownerActor = row.patch.ownerActor;
      if (!agg.orgFromPatch && typeof row.patch.orgId === "number" && row.patch.orgId > 0) {
        agg.orgId = row.patch.orgId;
        agg.orgFromPatch = true;
      }
      if (row.patch.status) agg.status = row.patch.status;
      if (row.ts) {
        agg.firstTs = agg.firstTs ?? row.ts;
        agg.lastTs = row.ts;
      }
      if (row.patch.note) agg.note = row.patch.note;
    } else {
      if (!agg.firstTs) agg.firstTs = row.event.ts;
      agg.lastTs = row.event.ts;
      if (row.event.type === "status_change") {
        // 当前格式下（patch 仅 create/close 两行）终态只在此推进——必须合并事件状态
        const st = (row.event as { status?: string }).status;
        if (typeof st === "string" && st) {
          agg.status = st;
          if (st === "running" && !agg.runningTs) agg.runningTs = row.event.ts;
          if (/^(succeeded|failed|cancelled)$/.test(st)) agg.terminalTs = row.event.ts;
        }
      }
      agg.events.push(row.event);
    }
  }

  // dry-run：聚合结果只展示，不触数据库（验证解析/状态机合并逻辑）
  if (values["dry-run"]) {
    console.log(`── dry-run 聚合 ────────────────────────────`);
    for (const agg of bySid.values()) {
      console.log(
        `${agg.sid} org=${agg.orgId}${agg.orgFromPatch ? "" : "（兜底）"} status=${agg.status} events=${agg.events.length} started=${agg.runningTs ?? agg.firstTs ?? "-"} ended=${agg.terminalTs ?? "-"}`,
      );
    }
    return;
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 5000 });

  // identity upsert（created_by=0 哨兵：装载器无登录上下文）
  const identityStmt = `INSERT INTO agent_identities (org_id, name, kind, created_by)
    VALUES ($1, '${IDENTITY_NAME}', 'pipeline', 0)
    ON CONFLICT (org_id, name) DO UPDATE SET status = 'active'
    RETURNING id`;

  const sessionStmt = `INSERT INTO agent_sessions
    (sid, identity_id, org_id, engine, engine_version, profile, status, started_at, ended_at, exit_info)
    VALUES ($1, $2, $3, '${ENGINE}', '${ENGINE_VERSION}', 'jsonl-load', $4, $5, $6, $7)
    ON CONFLICT (sid) DO UPDATE SET
      status = EXCLUDED.status,
      started_at = COALESCE(EXCLUDED.started_at, agent_sessions.started_at),
      ended_at = EXCLUDED.ended_at,
      exit_info = COALESCE(agent_sessions.exit_info, '{}'::jsonb) || COALESCE(EXCLUDED.exit_info, '{}'::jsonb)
    RETURNING id`;

  const eventStmt = `INSERT INTO agent_events (session_id, seq, ts, type, payload)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (session_id, seq) DO NOTHING`;

  let sessionsLoaded = 0;
  let eventsLoaded = 0;
  let orgFallbackCount = 0;

  for (const agg of bySid.values()) {
    if (!agg.orgFromPatch) orgFallbackCount++;
    try {
      const identity = await pool.query<{ id: string }>(identityStmt, [agg.orgId]);
      const identityId = identity.rows[0]?.id;
      if (!identityId) throw new Error("identity upsert 未返回 id");
      const terminated = /^(succeeded|failed|cancelled)$/.test(agg.status);
      const exit = JSON.stringify({ owner_actor: agg.ownerActor, ...(terminated && agg.note ? { note: agg.note } : {}) });
      const session = await pool.query<{ id: string }>(sessionStmt, [
        agg.sid,
        identityId,
        agg.orgId,
        agg.status,
        agg.runningTs ?? agg.firstTs ?? null,
        terminated ? (agg.terminalTs ?? agg.lastTs ?? null) : null,
        exit,
      ]);
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("session upsert 未返回 id");
      sessionsLoaded++;
      for (const ev of agg.events) {
        const { seq, ts, type, ...payload } = ev; // payload = 事件除 seq/ts/type 外剩余字段整体
        await pool.query(eventStmt, [sessionId, seq, ts, type, JSON.stringify(payload)]);
        eventsLoaded++;
      }
    } catch (err) {
      console.error(`[load] 会话 ${agg.sid} 失败：`, err instanceof Error ? err.message : err);
      // 不中断整批；错误注入 rows 计数由汇总反映
      parseFailures++;
    }
  }

  await pool.end();

  console.log(`── 装载汇总 ──────────────────────────────`);
  console.log(`读入行     : ${totalLines}`);
  console.log(`会话       : ${bySid.size}（装载成功 ${sessionsLoaded}，缺 org 走兜底 ${orgFallbackCount}）`);
  console.log(`事件       : ${eventsLoaded}`);
  console.log(`permission 行跳过 : ${permissionRows}（权威台账在 techhaven-mcp）`);
  console.log(`解析/装载失败   : ${parseFailures}`);
  console.log(`（本装载器未经 live PostgreSQL 验证，SQL 对照 schema v0.3；幂等，可重跑）`);
}

main().catch((err) => {
  console.error("[load] 装载中止：", err instanceof Error ? err.message : err);
  process.exit(1);
});
