import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import type {
  ProposalLifecycleEvent,
  ProposalLifecycleEventType,
  ProposalStatus,
  ProposalView,
} from "techhaven-contracts";
import { GatewayError } from "./sessions.js";
import { log } from "./log.js";

interface ProposalFileDetail {
  id: string;
  sessionId: string;
  orgId: number;
  tool: string;
  kind: string;
  subjectHashId: string;
  subjectId: number;
  fromStatus: string;
  toStatus: string;
  reason: string;
  expiresAt: string;
}

interface ProposalFileEvent {
  event: ProposalLifecycleEventType;
  ts: string;
  actor: string;
  proposal: ProposalFileDetail;
  note?: string;
}

export interface ProposalSnapshot {
  proposal: ProposalView;
  lifecycle: ProposalLifecycleEvent;
}

export interface DecideProposalInput {
  sessionId: string;
  orgId: number;
  proposalId: string;
  decision: "approve" | "reject";
  actor: string;
  note?: string;
}

/**
 * Control Plane proposal 端口。浏览器只经 Gateway/BFF 使用此端口；MCP worker 继续
 * 持有域状态机重校验与幂等应用职责，Gateway 不直接修改产品工单。
 */
export interface ProposalPort {
  listForSession(sessionId: string, orgId: number): Promise<ProposalSnapshot[]>;
  decide(input: DecideProposalInput): Promise<ProposalSnapshot>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStatus(value: unknown): value is ProposalStatus {
  return ["pending", "approved", "applying", "rejected", "applied", "expired"].includes(String(value));
}

function validEvent(value: unknown): value is ProposalLifecycleEventType {
  return ["created", "approved", "applying", "rejected", "applied", "expired"].includes(String(value));
}

function parseFileEvent(value: unknown): ProposalFileEvent | undefined {
  if (!isRecord(value) || !validEvent(value.event) || typeof value.ts !== "string" || typeof value.actor !== "string") return undefined;
  const proposal = isRecord(value.proposal) ? value.proposal : undefined;
  if (
    !proposal ||
    typeof proposal.id !== "string" ||
    typeof proposal.sessionId !== "string" ||
    !Number.isInteger(proposal.orgId) ||
    typeof proposal.tool !== "string" ||
    typeof proposal.kind !== "string" ||
    typeof proposal.subjectHashId !== "string" ||
    !Number.isInteger(proposal.subjectId) ||
    typeof proposal.fromStatus !== "string" ||
    typeof proposal.toStatus !== "string" ||
    typeof proposal.reason !== "string" ||
    typeof proposal.expiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    event: value.event,
    ts: value.ts,
    actor: value.actor,
    proposal: proposal as unknown as ProposalFileDetail,
    ...(typeof value.note === "string" && value.note ? { note: value.note } : {}),
  };
}

function statusForEvent(event: ProposalLifecycleEventType): ProposalStatus {
  return event === "created" ? "pending" : event;
}

function toView(event: ProposalFileEvent): ProposalView {
  const detail = event.proposal;
  return {
    id: detail.id,
    sessionId: detail.sessionId,
    orgId: detail.orgId,
    tool: detail.tool,
    subjectType: detail.kind,
    subjectHashId: detail.subjectHashId,
    fromStatus: detail.fromStatus,
    toStatus: detail.toStatus,
    reason: detail.reason,
    status: statusForEvent(event.event),
    expiresAt: detail.expiresAt,
    updatedAt: event.ts,
    ...(event.note ? { note: event.note } : {}),
  };
}

function snapshot(event: ProposalFileEvent): ProposalSnapshot {
  const proposal = toView(event);
  return {
    proposal,
    lifecycle: {
      event: event.event,
      ts: event.ts,
      actor: event.actor,
      proposal,
      ...(event.note ? { note: event.note } : {}),
    },
  };
}

function notFound(): GatewayError {
  // sid / org / proposal 任一不匹配均返回同一 404，避免跨组织枚举。
  return new GatewayError(404, "提案不存在或不属于当前会话");
}

function conflict(id: string, status: ProposalStatus, decision: "approve" | "reject"): GatewayError {
  // applying：业务写已被 worker 独占领取，撤回无法撤销已发生的写入 → 明确冲突（审查意见 F2）
  if (status === "applying") {
    return new GatewayError(409, `提案 ${id} 正在应用（applying），无法${decision === "approve" ? "重复批准" : "撤回"}`);
  }
  return new GatewayError(409, `提案 ${id} 当前状态为 ${status}，不能执行 ${decision}`);
}

/** 与 techhaven-mcp ProposalStore 共享 append-only JSONL 的单实例开发适配器。 */
export class JsonlProposalPort implements ProposalPort {
  private readonly decisionTails = new Map<string, Promise<ProposalSnapshot>>();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  async listForSession(sessionId: string, orgId: number): Promise<ProposalSnapshot[]> {
    const states = this.fold();
    const out: ProposalSnapshot[] = [];
    for (const state of states.values()) {
      if (state.proposal.sessionId !== sessionId || state.proposal.orgId !== orgId) continue;
      out.push(this.expireIfNeeded(state));
    }
    return out;
  }

  async decide(input: DecideProposalInput): Promise<ProposalSnapshot> {
    const previous = this.decisionTails.get(input.proposalId);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.decideNow(input));
    this.decisionTails.set(input.proposalId, next);
    try {
      return await next;
    } finally {
      if (this.decisionTails.get(input.proposalId) === next) this.decisionTails.delete(input.proposalId);
    }
  }

  async close(): Promise<void> {}

  private decideNow(input: DecideProposalInput): ProposalSnapshot {
    const found = this.fold().get(input.proposalId);
    if (!found || found.proposal.sessionId !== input.sessionId || found.proposal.orgId !== input.orgId) throw notFound();
    const current = this.expireIfNeeded(found);
    const status = current.proposal.status;

    if (input.decision === "approve" && (status === "approved" || status === "applied")) return current;
    if (input.decision === "reject" && status === "rejected") return current;

    const allowed = status === "pending" || (status === "approved" && input.decision === "reject");
    if (!allowed) throw conflict(input.proposalId, status, input.decision);

    const event: ProposalFileEvent = {
      event: input.decision === "approve" ? "approved" : "rejected",
      ts: new Date().toISOString(),
      actor: input.actor,
      proposal: this.fileDetail(current.proposal),
      ...(input.note ? { note: input.note } : {}),
    };
    this.append(event);
    return snapshot(event);
  }

  private fold(): Map<string, ProposalSnapshot> {
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const states = new Map<string, ProposalSnapshot>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = parseFileEvent(JSON.parse(line));
        if (!event) {
          log("proposal JSONL：跳过无效事件", line.slice(0, 80));
          continue;
        }
        const current = states.get(event.proposal.id);
        if (event.event === "created") {
          if (!current) states.set(event.proposal.id, snapshot(event));
          continue;
        }
        if (!current) continue;
        const nextStatus = statusForEvent(event.event);
        const currentStatus = current.proposal.status;
        const allowed =
          (currentStatus === "pending" && ["approved", "rejected", "expired"].includes(nextStatus)) ||
          (currentStatus === "approved" && ["applying", "applied", "rejected"].includes(nextStatus)) ||
          // 领取态只允许补齐终态；人工撤回在 decide 侧被拒，这里只负责正确折叠文件里已有的事件
          (currentStatus === "applying" && ["applied", "rejected"].includes(nextStatus));
        if (allowed) states.set(event.proposal.id, snapshot(event));
      } catch {
        log("proposal JSONL：跳过无法解析的行", line.slice(0, 80));
      }
    }
    return states;
  }

  private expireIfNeeded(state: ProposalSnapshot): ProposalSnapshot {
    if (state.proposal.status !== "pending" || Date.now() <= Date.parse(state.proposal.expiresAt)) return state;
    const event: ProposalFileEvent = {
      event: "expired",
      ts: new Date().toISOString(),
      actor: "system",
      proposal: this.fileDetail(state.proposal),
      note: "超过未决时限，自动过期（视为拒绝）",
    };
    this.append(event);
    return snapshot(event);
  }

  private fileDetail(view: ProposalView): ProposalFileDetail {
    const state = this.readCreated(view.id);
    if (!state) throw notFound();
    return state.proposal;
  }

  private readCreated(id: string): ProposalFileEvent | undefined {
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return undefined;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = parseFileEvent(JSON.parse(line));
        if (event?.event === "created" && event.proposal.id === id) return event;
      } catch {
        // fold() 统一记录损坏行；这里仅查 created 快照。
      }
    }
    return undefined;
  }

  private append(event: ProposalFileEvent): void {
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
  }
}

interface ProposalRow {
  proposal_ref: string;
  sid: string;
  org_id: number;
  tool_name: string;
  subject_type: string;
  change: Record<string, unknown>;
  status: ProposalStatus;
  expires_at: Date | string;
  created_at: Date | string;
  decided_by: string | number | null;
  decided_at: Date | string | null;
  applied_at: Date | string | null;
  apply_note: string | null;
}

const SELECT_PROPOSAL = `SELECT
    p.proposal_ref, s.sid, p.org_id, p.tool_name, p.subject_type, p.change, p.status,
    p.expires_at, p.created_at, p.decided_by, p.decided_at, p.applied_at, p.apply_note
  FROM agent_write_proposals p
  JOIN agent_sessions s ON s.id = p.session_id`;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`提案数据库字段无效：${field}`);
  return value;
}

function rowSnapshot(row: ProposalRow): ProposalSnapshot {
  if (!validStatus(row.status)) throw new Error(`提案数据库状态无效：${String(row.status)}`);
  const change = isRecord(row.change) ? row.change : {};
  const updatedAt = row.applied_at ?? row.decided_at ?? (row.status === "expired" ? row.expires_at : row.created_at);
  const event: ProposalLifecycleEventType = row.status === "pending" ? "created" : row.status;
  const actor =
    row.status === "approved" || row.status === "rejected"
      ? row.decided_by === null
        ? "system"
        : `user:${row.decided_by}`
      : row.status === "pending"
        ? "agent"
        : "system";
  const proposal: ProposalView = {
    id: row.proposal_ref,
    sessionId: row.sid,
    orgId: Number(row.org_id),
    tool: row.tool_name,
    subjectType: row.subject_type,
    subjectHashId: requiredText(change.subject_hash_id, "change.subject_hash_id"),
    fromStatus: requiredText(change.from_status, "change.from_status"),
    toStatus: requiredText(change.to_status, "change.to_status"),
    reason: requiredText(change.reason, "change.reason"),
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    ...(row.apply_note ? { note: row.apply_note } : {}),
  };
  return {
    proposal,
    lifecycle: {
      event,
      ts: proposal.updatedAt,
      actor,
      proposal,
      ...(proposal.note ? { note: proposal.note } : {}),
    },
  };
}

/** PostgreSQL authoritative proposal adapter；与 MCP worker 共享 agent_write_proposals。 */
export class PgProposalPort implements ProposalPort {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(dbUrl: string, schema = "public"): Promise<PgProposalPort> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error(`PostgreSQL schema 非法：${schema}`);
    const pool = new pg.Pool({
      connectionString: dbUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("SELECT 1");
      return new PgProposalPort(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async listForSession(sessionId: string, orgId: number): Promise<ProposalSnapshot[]> {
    await this.pool.query(
      `UPDATE agent_write_proposals p
          SET status = 'expired', apply_note = COALESCE(apply_note, '超过未决时限，自动过期（视为拒绝）')
         FROM agent_sessions s
        WHERE p.session_id = s.id AND s.sid = $1 AND p.org_id = $2
          AND p.status = 'pending' AND p.expires_at <= now()`,
      [sessionId, orgId],
    );
    const result = await this.pool.query<ProposalRow>(
      `${SELECT_PROPOSAL} WHERE s.sid = $1 AND p.org_id = $2 ORDER BY p.created_at, p.id`,
      [sessionId, orgId],
    );
    return result.rows.map(rowSnapshot);
  }

  async decide(input: DecideProposalInput): Promise<ProposalSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ProposalRow>(
        `${SELECT_PROPOSAL} WHERE p.proposal_ref = $1 AND s.sid = $2 AND p.org_id = $3 FOR UPDATE OF p`,
        [input.proposalId, input.sessionId, input.orgId],
      );
      const row = result.rows[0];
      if (!row) throw notFound();

      if (row.status === "pending" && Date.now() > new Date(row.expires_at).getTime()) {
        await client.query(
          `UPDATE agent_write_proposals
              SET status = 'expired', apply_note = COALESCE(apply_note, '超过未决时限，自动过期（视为拒绝）')
            WHERE proposal_ref = $1 AND org_id = $2 AND status = 'pending'`,
          [input.proposalId, input.orgId],
        );
        row.status = "expired";
        row.apply_note ??= "超过未决时限，自动过期（视为拒绝）";
      }

      if (input.decision === "approve" && (row.status === "approved" || row.status === "applied")) {
        await client.query("COMMIT");
        return rowSnapshot(row);
      }
      if (input.decision === "reject" && row.status === "rejected") {
        await client.query("COMMIT");
        return rowSnapshot(row);
      }
      const allowed = row.status === "pending" || (row.status === "approved" && input.decision === "reject");
      if (!allowed) throw conflict(input.proposalId, row.status, input.decision);

      const target: ProposalStatus = input.decision === "approve" ? "approved" : "rejected";
      const actorId = Number(input.actor.slice("user:".length));
      const updated = await client.query<ProposalRow>(
        `UPDATE agent_write_proposals p
            SET status = $1, decided_by = $2, decided_at = now(), apply_note = COALESCE($3, apply_note)
           FROM agent_sessions s
          WHERE p.session_id = s.id AND p.proposal_ref = $4 AND s.sid = $5 AND p.org_id = $6 AND p.status = $7
          RETURNING p.proposal_ref, s.sid, p.org_id, p.tool_name, p.subject_type, p.change, p.status,
                    p.expires_at, p.created_at, p.decided_by, p.decided_at, p.applied_at, p.apply_note`,
        [target, actorId, input.note ?? null, input.proposalId, input.sessionId, input.orgId, row.status],
      );
      if (updated.rowCount !== 1) throw new GatewayError(409, `提案 ${input.proposalId} 已被其他审批者推进`);
      await client.query("COMMIT");
      return rowSnapshot(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
