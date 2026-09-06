import type { PgContext } from "../db/context.js";
import type { ProposalEvent } from "./store.js";
import { log } from "../log.js";

/**
 * 写提案落 PG sink（对应 docs/agent-db/schema.sql §4 agent_write_proposals）。
 *
 * 定位：JSONL 提案存储（src/proposals/store.ts）仍是唯一权威来源——server 与人工审批 CLI
 * 靠同一份文件交接；本 sink 是可选镜像，把每次事件同步到 agent_write_proposals 表，
 * 供后端 / 治理侧查询（v_agent_audit 视图等）。
 * 任何失败都只记 stderr，绝不影响主流程（fire-and-forget，绝不抛出）。
 *
 * 列对照（逐字依据 schema.sql v0.2）：
 *   proposal_ref ← ProposalDetail.id（字符串 ID ↔ BIGINT 主键的映射，UNIQUE）
 *   session_id   ← PgContext.sessionId（agent_sessions.id，BIGINT 外键；
 *                  注意不是 ProposalDetail.sessionId——那是 token 的 sid 字符串）
 *   subject_type ← ProposalDetail.kind（requirement | bug | task）
 *   change       ← { from_status, to_status, reason }（jsonb）
 *   risk_level   ← 'low'（P2 现状：状态迁移类写操作统一按低危起步，工具目录治理后再分级）
 */
export class ProposalDbSink {
  constructor(private ctx: PgContext) {}

  /** 落一条提案事件；绝不抛出，失败记 stderr */
  async onEvent(event: ProposalEvent): Promise<void> {
    try {
      const p = event.proposal;
      switch (event.event) {
        case "created":
          await this.ctx.pool.query(
            `INSERT INTO agent_write_proposals
               (session_id, org_id, tool_name, subject_type, subject_id, change, risk_level, status, expires_at, proposal_ref)
             VALUES ($1, $2, $3, $4, $5, $6, 'low', 'pending', $7, $8)
             ON CONFLICT (proposal_ref) DO NOTHING`,
            [
              this.ctx.sessionId,
              p.orgId,
              p.tool,
              p.kind,
              p.subjectId,
              JSON.stringify({ from_status: p.fromStatus, to_status: p.toStatus, reason: p.reason }),
              p.expiresAt,
              p.id,
            ],
          );
          break;
        case "approved":
        case "rejected":
          // decided_by=0：与 PgContext 的 created_by=0 同一套哨兵值——MCP 进程无登录上下文，
          // 真实批准人（users.id）要等审批链路服务化后回填
          await this.ctx.pool.query(
            `UPDATE agent_write_proposals
                SET status = $1, decided_by = 0, decided_at = now()
              WHERE proposal_ref = $2`,
            [event.event, p.id],
          );
          break;
        case "applying":
          // 镜像应用领取态（审查意见 F2）：让治理侧能看到「已批准且正在写」，
          // 租约与重新领取由权威存储（PG repository 的 apply_lease_expires_at）持有。
          await this.ctx.pool.query(
            `UPDATE agent_write_proposals
                SET status = 'applying'
              WHERE proposal_ref = $1 AND status IN ('pending', 'approved', 'applying')`,
            [p.id],
          );
          break;
        case "applied":
          await this.ctx.pool.query(
            `UPDATE agent_write_proposals
                SET status = 'applied', applied_at = now()
              WHERE proposal_ref = $1`,
            [p.id],
          );
          break;
        case "expired":
          // 只从 pending 过期：与 JSONL 折叠的「状态单调推进」规则一致，不覆盖人工已批/已拒
          await this.ctx.pool.query(
            `UPDATE agent_write_proposals
                SET status = 'expired'
              WHERE proposal_ref = $1 AND status = 'pending'`,
            [p.id],
          );
          break;
      }
    } catch (err) {
      log(`DB 提案双写失败（${event.event} ${event.proposal.id}）:`, err);
    }
  }
}
