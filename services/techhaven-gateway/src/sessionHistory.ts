/** Session serialization and validated JSONL recovery; no live engine or subscriber ownership. */
import { existsSync, readFileSync } from "node:fs";
import type { EngineEvent, SessionStatus } from "./types.js";
import type { SessionRecord } from "./sessions.js";
import { nowIso } from "./util.js";
import { log } from "./log.js";

interface RecoveredSession {
  record: SessionRecord;
  retentionMs?: number;
}

const TERMINAL_STATUSES: readonly SessionStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * kind:"session" patch 行的 patch 载荷（装载器 scripts/load-events.ts 据此补 agent_sessions
 * 的归属与状态列）。归属字段来自 create 输入；JSON.stringify 会省略取值为 undefined 的键，
 * 可选字段缺省即不出现在行中。prompt 刻意不入行：agent_sessions 无 prompt 列，原文不进库。
 */
interface SessionPatchJson {
  ownerActor?: string;
  status: SessionStatus;
  orgId?: number;
  subjectType?: string;
  subjectId?: string;
  createdAt?: string;
  note?: string;
}

/** patch 行载荷：create 全量（归属 + 状态），后续收尾 patch 只带变化字段（如 note） */
export function sessionPatch(record: SessionRecord, status: SessionStatus, note?: string): SessionPatchJson {
  return {
    ownerActor: record.ownerActor,
    status,
    orgId: record.orgId,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    createdAt: record.createdAt,
    note,
  };
}

export const RECOVERED_PROMPT = "（Gateway 重启恢复：原始 prompt 未持久化）";

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isSessionStatusValue(value: unknown): value is SessionStatus {
  return (
    typeof value === "string" &&
    (TERMINAL_STATUSES as readonly string[]).concat(["queued", "running", "awaiting_permission"]).includes(value)
  );
}

function isProposalViewValue(value: unknown): boolean {
  const proposal = jsonRecord(value);
  return Boolean(
    proposal &&
    typeof proposal.id === "string" &&
    typeof proposal.sessionId === "string" &&
    Number.isInteger(proposal.orgId) &&
    typeof proposal.tool === "string" &&
    typeof proposal.subjectType === "string" &&
    typeof proposal.subjectHashId === "string" &&
    typeof proposal.fromStatus === "string" &&
    typeof proposal.toStatus === "string" &&
    typeof proposal.reason === "string" &&
    ["pending", "approved", "applying", "rejected", "applied", "expired"].includes(String(proposal.status)) &&
    typeof proposal.expiresAt === "string" &&
    typeof proposal.updatedAt === "string",
  );
}

/** JSONL 是跨进程恢复输入，必须做运行时校验，不能直接断言为 EngineEvent。 */
function isEngineEventValue(value: unknown): value is EngineEvent {
  const event = jsonRecord(value);
  if (!event || !Number.isInteger(event.seq) || (event.seq as number) <= 0 || typeof event.ts !== "string") return false;
  switch (event.type) {
    case "assistant_chunk":
      return typeof event.text === "string";
    case "tool_call":
      return typeof event.tool === "string" && typeof event.argsDigest === "string";
    case "tool_result":
      return typeof event.tool === "string" && typeof event.ok === "boolean";
    case "permission_request":
      return typeof event.requestId === "string" && typeof event.tool === "string";
    case "proposal_lifecycle":
      return (
        ["created", "approved", "applying", "rejected", "applied", "expired"].includes(String(event.event)) &&
        typeof event.actor === "string" &&
        isProposalViewValue(event.proposal)
      );
    case "status_change":
      return isSessionStatusValue(event.status);
    case "error":
      return typeof event.message === "string";
    default:
      return false;
  }
}

/** 按 seq 升序且幂等插入；返回 false 表示同 sid + seq 已存在。 */
export function insertBySeq(record: SessionRecord, ev: EngineEvent): boolean {
  const events = record.events;
  if (events.length === 0 || ev.seq > events[events.length - 1].seq) {
    events.push(ev);
    return true;
  }
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].seq < ev.seq) low = mid + 1;
    else high = mid;
  }
  if (events[low]?.seq === ev.seq) return false;
  events.splice(low, 0, ev);
  return true;
}

export function readSessionHistory(jsonlPath: string, retentionMinutes: number): RecoveredSession[] {
  if (!existsSync(jsonlPath)) return [];
  const staged = new Map<
    string,
    {
      patch: Partial<SessionPatchJson>;
      events: EngineEvent[];
    }
  >();
  let skipped = 0;
  let expired = 0;
  const entry = (sid: string) => {
    let value = staged.get(sid);
    if (!value) {
      value = { patch: {}, events: [] };
      staged.set(sid, value);
    }
    return value;
  };

  for (const rawLine of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const line = jsonRecord(JSON.parse(rawLine));
      if (!line || typeof line.sid !== "string") {
        skipped += 1;
        continue;
      }
      if (line.kind === "session") {
        const patch = jsonRecord(line.patch);
        if (!patch) {
          skipped += 1;
          continue;
        }
        const target = entry(line.sid).patch;
        if (typeof patch.ownerActor === "string" && /^user:[1-9]\d*$/.test(patch.ownerActor)) target.ownerActor = patch.ownerActor;
        if (isSessionStatusValue(patch.status)) target.status = patch.status;
        if (typeof patch.orgId === "number" && Number.isInteger(patch.orgId)) target.orgId = patch.orgId;
        if (typeof patch.subjectType === "string") target.subjectType = patch.subjectType;
        if (typeof patch.subjectId === "string") target.subjectId = patch.subjectId;
        if (typeof patch.createdAt === "string") target.createdAt = patch.createdAt;
        continue;
      }
      if (line.kind === "event" && isEngineEventValue(line.event)) {
        entry(line.sid).events.push(line.event);
        continue;
      }
      // permission 行属于审计留痕，不参与会话视图重建。
      if (line.kind !== "permission") skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  const interrupted: SessionRecord[] = [];
  const records: RecoveredSession[] = [];
  let recovered = 0;
  for (const [sid, source] of staged) {
    if (source.patch.orgId === undefined) {
      skipped += 1;
      continue;
    }
    const record: SessionRecord = {
      sid,
      orgId: source.patch.orgId,
      ownerActor: source.patch.ownerActor,
      subjectType: source.patch.subjectType,
      subjectId: source.patch.subjectId,
      prompt: RECOVERED_PROMPT,
      status: source.patch.status ?? "queued",
      createdAt: source.patch.createdAt ?? source.events[0]?.ts ?? nowIso(),
      events: [],
      subscribers: new Set(),
    };
    for (const event of source.events) insertBySeq(record, event);
    for (const event of record.events) {
      if (event.type === "status_change") {
        record.status = event.status;
        if (isTerminalStatus(event.status)) record.endedAt = event.ts;
        else record.endedAt = undefined;
      }
    }
    record.closed = isTerminalStatus(record.status);
    let restoredRetentionMs: number | undefined;
    if (record.closed && record.endedAt && retentionMinutes > 0) {
      restoredRetentionMs = retentionMinutes * 60_000 - (Date.now() - Date.parse(record.endedAt));
      if (!Number.isFinite(restoredRetentionMs) || restoredRetentionMs <= 0) {
        expired += 1;
        continue;
      }
    }
    records.push({ record, retentionMs: restoredRetentionMs });
    recovered += 1;
    if (!record.closed) interrupted.push(record);
  }
  if (recovered > 0 || skipped > 0 || expired > 0) {
    log(`JSONL 恢复：sessions=${recovered} interrupted=${interrupted.length} expired=${expired} skipped=${skipped}`);
  }
  return records;
}
