import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { TicketKind } from "../domain/types.js";
import type {
  ProposalApplyOutcome,
  ProposalDetail,
  ProposalRepository,
  ProposalState,
  ProposalStatus,
} from "./store.js";
import { DEFAULT_APPLY_LEASE_MS } from "./store.js";

interface ProposalRow {
  proposal_ref: string;
  sid: string;
  org_id: number;
  tool_name: string;
  subject_type: TicketKind;
  subject_id: string;
  change: {
    from_status?: unknown;
    to_status?: unknown;
    reason?: unknown;
    subject_hash_id?: unknown;
  };
  status: ProposalStatus;
  expires_at: Date | string;
}

function proposalId(): string {
  return `p_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

function requestKey(detail: Omit<ProposalDetail, "id" | "expiresAt">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: detail.sessionId,
        orgId: detail.orgId,
        tool: detail.tool,
        kind: detail.kind,
        subjectId: detail.subjectId,
        fromStatus: detail.fromStatus,
        toStatus: detail.toStatus,
        reason: detail.reason,
      }),
    )
    .digest("hex");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`提案数据库字段无效：${field}`);
  return value;
}

function detailFromRow(row: ProposalRow): ProposalDetail {
  return {
    id: row.proposal_ref,
    sessionId: row.sid,
    orgId: Number(row.org_id),
    tool: row.tool_name,
    kind: row.subject_type,
    subjectHashId: text(row.change.subject_hash_id, "change.subject_hash_id"),
    subjectId: Number(row.subject_id),
    fromStatus: text(row.change.from_status, "change.from_status"),
    toStatus: text(row.change.to_status, "change.to_status"),
    reason: text(row.change.reason, "change.reason"),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

const SELECT_ROW = `SELECT
    p.proposal_ref, s.sid, p.org_id, p.tool_name, p.subject_type, p.subject_id,
    p.change, p.status, p.expires_at
  FROM agent_write_proposals p
  JOIN agent_sessions s ON s.id = p.session_id`;

function actorUserId(actor: string): number | null {
  const match = /^user:(\d+)$/.exec(actor);
  return match ? Number(match[1]) : null;
}

/**
 * PostgreSQL 权威 proposal repository。
 *
 * 所有状态推进在数据库事务内完成；并发批准依赖行锁和带当前状态条件的 UPDATE。
 * applyApproved 会在域幂等写期间持有 proposal 行锁，使多个 MCP worker 中只有一个执行回调。
 */
export class PgProposalRepository implements ProposalRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMinutes: number,
    private readonly orgId: number,
    /** 应用租约：领取后未回填终态超过此时长，允许其他 worker 重新领取 */
    private readonly applyLeaseMs: number = DEFAULT_APPLY_LEASE_MS,
  ) {}

  async create(detail: Omit<ProposalDetail, "id" | "expiresAt">): Promise<ProposalDetail> {
    if (detail.orgId !== this.orgId) throw new Error("提案组织与 PostgreSQL repository 绑定组织不一致");
    const id = proposalId();
    const key = requestKey(detail);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
    const change = {
      from_status: detail.fromStatus,
      to_status: detail.toStatus,
      reason: detail.reason,
      subject_hash_id: detail.subjectHashId,
    };
    const result = await this.pool.query(
      `INSERT INTO agent_write_proposals
         (proposal_ref, request_key, session_id, org_id, tool_name, subject_type, subject_id,
          change, risk_level, status, expires_at)
       SELECT $1, $2, s.id, $3, $4, $5, $6, $7::jsonb, 'low', 'pending', $8
       FROM agent_sessions s
       WHERE s.sid = $9 AND s.org_id = $3
       ON CONFLICT (session_id, request_key) DO UPDATE
         SET proposal_ref = agent_write_proposals.proposal_ref
       RETURNING proposal_ref, expires_at`,
      [id, key, detail.orgId, detail.tool, detail.kind, detail.subjectId, JSON.stringify(change), expiresAt, detail.sessionId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`无法创建提案：会话 ${detail.sessionId} 不存在或组织不匹配`);
    }
    const returned = result.rows[0] as { proposal_ref: string; expires_at: Date | string };
    return { ...detail, id: returned.proposal_ref, expiresAt: new Date(returned.expires_at).toISOString() };
  }

  async appendEvent(
    event: "approved" | "applying" | "rejected" | "applied" | "expired",
    id: string,
    actor: string,
    note?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.lockState(client, id);
      if (state.status === "unknown" || state.detail === null) throw new Error(`提案不存在：${id}`);

      const current = state.status;
      const allowed =
        (current === "pending" && (event === "approved" || event === "rejected" || event === "expired")) ||
        // 领取态：只允许补齐终态；人工撤回 applying 必须失败（审查意见 F2）
        (current === "applying" && (event === "applied" || (event === "rejected" && actor === "system"))) ||
        (current === "approved" && (event === "applied" || event === "rejected" || event === "applying"));
      if (!allowed) {
        throw new Error(
          current === "applying" && event === "rejected"
            ? `提案 ${id} 正在应用（applying），无法撤回；请等待应用结束或联系管理员处理`
            : `提案 ${id} 当前状态为 ${current}，不允许追加 ${event} 事件`,
        );
      }

      const decided = event === "approved" || event === "rejected";
      const applied = event === "applied";
      const result = await client.query(
        `UPDATE agent_write_proposals
            SET status = $1,
                decided_by = CASE WHEN $2::boolean THEN $3 ELSE decided_by END,
                decided_at = CASE WHEN $2::boolean THEN now() ELSE decided_at END,
                applied_at = CASE WHEN $4::boolean THEN now() ELSE applied_at END,
                apply_lease_expires_at = CASE WHEN $1 = 'applied' OR $1 = 'rejected' THEN NULL ELSE apply_lease_expires_at END,
                apply_note = COALESCE($5, apply_note)
          WHERE proposal_ref = $6 AND org_id = $7 AND status = $8`,
        [event, decided, actorUserId(actor), applied, note ?? null, id, this.orgId, current],
      );
      if (result.rowCount !== 1) throw new Error(`提案 ${id} 状态已被其他审批者推进`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getState(id: string): Promise<ProposalState> {
    await this.pool.query(
      `UPDATE agent_write_proposals
          SET status = 'expired', apply_note = COALESCE(apply_note, '超过未决时限，自动过期（视为拒绝）')
        WHERE proposal_ref = $1 AND org_id = $2 AND status = 'pending' AND expires_at <= now()`,
      [id, this.orgId],
    );
    const result = await this.pool.query<ProposalRow>(`${SELECT_ROW} WHERE p.proposal_ref = $1 AND p.org_id = $2`, [id, this.orgId]);
    const row = result.rows[0];
    return row ? { status: row.status, detail: detailFromRow(row) } : { status: "unknown", detail: null };
  }

  async list(): Promise<Array<{ detail: ProposalDetail; status: ProposalStatus }>> {
    await this.pool.query(
      `UPDATE agent_write_proposals
          SET status = 'expired', apply_note = COALESCE(apply_note, '超过未决时限，自动过期（视为拒绝）')
        WHERE org_id = $1 AND status = 'pending' AND expires_at <= now()`,
      [this.orgId],
    );
    const result = await this.pool.query<ProposalRow>(`${SELECT_ROW} WHERE p.org_id = $1 ORDER BY p.created_at, p.id`, [this.orgId]);
    return result.rows.map((row) => ({ detail: detailFromRow(row), status: row.status }));
  }

  /**
   * 两阶段应用（审查意见 F2）：
   *   1) 事务内把 approved 推进为 applying 并写入租约，然后**立即提交释放行锁**——
   *      这样人工撤回请求不会被业务写回调阻塞，而是读到 applying 直接返回 409；
   *   2) 执行业务写回调（不持锁）；
   *   3) 再开事务按 `status = 'applying'` 条件写入终态，条件不成立说明有人/有进程已改状态。
   *
   * 持锁执行回调（旧行为）虽然也能串行化，但会把撤回请求挂起到写入结束，
   * 且崩溃时没有任何痕迹表明「有人正在写」——applying + 租约让失联可被检测和接管。
   */
  async applyApproved(id: string, apply: (detail: ProposalDetail) => Promise<ProposalApplyOutcome>): Promise<boolean> {
    // 阶段 1：独占领取
    const claim = await this.pool.query(
      `UPDATE agent_write_proposals
          SET status = 'applying',
              apply_lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
              apply_note = COALESCE($4, apply_note)
        WHERE proposal_ref = $1 AND org_id = $2
          AND (status = 'approved'
               OR (status = 'applying' AND (apply_lease_expires_at IS NULL OR apply_lease_expires_at <= now())))
        RETURNING proposal_ref`,
      [id, this.orgId, String(this.applyLeaseMs), "已领取应用，撤回请求将被拒绝"],
    );
    if (claim.rowCount !== 1) return false;

    const state = await this.getState(id);
    if (state.status !== "applying" || state.detail === null) return false;

    // 阶段 2：业务写（不持锁）
    let outcome: ProposalApplyOutcome;
    try {
      outcome = await apply(state.detail);
    } catch (error) {
      // 应用异常：留痕终态（避免 applying 悬挂到租约过期）后上抛，绝不谎报成功
      await this.pool
        .query(
          `UPDATE agent_write_proposals
              SET status = 'rejected', apply_lease_expires_at = NULL,
                  apply_note = $2, decided_by = 0, decided_at = now()
            WHERE proposal_ref = $1 AND org_id = $3 AND status = 'applying'`,
          [id, `应用失败：${error instanceof Error ? error.message : String(error)}`, this.orgId],
        )
        .catch(() => undefined);
      throw error;
    }

    // 阶段 3：按 applying 条件写终态
    const result = await this.pool.query(
      `UPDATE agent_write_proposals
          SET status = $1,
              applied_at = CASE WHEN $1 = 'applied' THEN now() ELSE applied_at END,
              apply_lease_expires_at = NULL,
              apply_note = COALESCE($2, apply_note)
        WHERE proposal_ref = $3 AND org_id = $4 AND status = 'applying'`,
      [outcome.status, outcome.note ?? null, id, this.orgId],
    );
    if (result.rowCount !== 1) throw new Error(`提案 ${id} 应用状态被并发修改`);
    return true;
  }

  private async lockState(client: pg.PoolClient, id: string): Promise<ProposalState> {
    const result = await client.query<ProposalRow>(`${SELECT_ROW} WHERE p.proposal_ref = $1 AND p.org_id = $2 FOR UPDATE OF p`, [
      id,
      this.orgId,
    ]);
    const row = result.rows[0];
    if (!row) return { status: "unknown", detail: null };
    if (row.status === "pending" && Date.now() > new Date(row.expires_at).getTime()) {
      await client.query(
        `UPDATE agent_write_proposals
            SET status = 'expired', apply_note = COALESCE(apply_note, '超过未决时限，自动过期（视为拒绝）')
          WHERE proposal_ref = $1 AND org_id = $2 AND status = 'pending'`,
        [id, this.orgId],
      );
      return { status: "expired", detail: detailFromRow(row) };
    }
    return { status: row.status, detail: detailFromRow(row) };
  }
}
