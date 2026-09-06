/**
 * TechHaven Agent 控制面共享契约（类型单源）。
 *
 * 归属：Gateway（控制面）与 techhaven-mcp（工具面）及前端 SPA 共同消费，
 * 跨边界只认这里定义的类型。改动需双方（网关/MCP）同步评审并过对应 smoke。
 *
 * 分组：
 * - 引擎事件（driver ↔ Gateway，TH-RFC-001 §05.1 冻结）
 * - 事件信封（SSE 线上形态，TH-RFC-001 §6）
 * - 会话视图与 API 请求/响应（Gateway HTTP）
 * - 提案生命周期（techhaven-mcp 写提案审批流的状态/事件）
 * - 错误信封
 */

// ------------------------------------------------------------------
// 引擎事件（driver ↔ Gateway；mock 与 dsh 驱动输出同一形态）
// ------------------------------------------------------------------

export type SessionStatus = "queued" | "running" | "awaiting_permission" | "succeeded" | "failed" | "cancelled";

export type EngineEvent =
  | { type: "assistant_chunk"; seq: number; ts: string; text: string }
  | { type: "tool_call"; seq: number; ts: string; tool: string; argsDigest: string; args?: unknown }
  | { type: "tool_result"; seq: number; ts: string; tool: string; ok: boolean; summary?: string }
  | { type: "permission_request"; seq: number; ts: string; requestId: string; tool: string; reason?: string }
  | {
      type: "proposal_lifecycle";
      seq: number;
      ts: string;
      event: ProposalLifecycleEventType;
      actor: string;
      proposal: ProposalView;
      note?: string;
    }
  | { type: "status_change"; seq: number; ts: string; status: SessionStatus; detail?: string }
  | { type: "error"; seq: number; ts: string; message: string };

/** 引擎事件去掉 seq/type/ts（三者上提到信封）后的载荷形态 */
export type EngineEventPayload =
  | { text: string }
  | { tool: string; argsDigest: string; args?: unknown }
  | { tool: string; ok: boolean; summary?: string }
  | { requestId: string; tool: string; reason?: string }
  | { event: ProposalLifecycleEventType; actor: string; proposal: ProposalView; note?: string }
  | { status: SessionStatus; detail?: string }
  | { message: string };

// ------------------------------------------------------------------
// 事件信封（SSE 线上形态，TH-RFC-001 §6）
// ------------------------------------------------------------------

/**
 * 事件信封：SSE 数据帧本体（可辨识联合，`type` 与 `payload` 一一对应）。
 * - `seq` 会话内递增；`eventId = "<sessionId>:<seq>"`，与 SSE `id:` 对齐，
 *   断线重连经 Last-Event-ID / `?after=` 回放（见 Gateway http.ts）。
 * - `occurredAt` 与载荷内不再重复携带时间；`traceId` 由 R2 OpenTelemetry 接入后填充，
 *   PoC 阶段固定空串。
 */
export type EventEnvelope = {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  orgId: number;
  seq: number;
  occurredAt: string;
  traceId: string;
} & (
  | { type: "assistant_chunk"; payload: { text: string } }
  | { type: "tool_call"; payload: { tool: string; argsDigest: string; args?: unknown } }
  | { type: "tool_result"; payload: { tool: string; ok: boolean; summary?: string } }
  | { type: "permission_request"; payload: { requestId: string; tool: string; reason?: string } }
  | {
      type: "proposal_lifecycle";
      payload: { event: ProposalLifecycleEventType; actor: string; proposal: ProposalView; note?: string };
    }
  | { type: "status_change"; payload: { status: SessionStatus; detail?: string } }
  | { type: "error"; payload: { message: string } }
);

// ------------------------------------------------------------------
// 会话与 Gateway HTTP API
// ------------------------------------------------------------------

export interface SessionView {
  sid: string;
  orgId: number;
  subjectType?: string;
  subjectId?: string;
  prompt: string;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
}

export interface CreateSessionRequest {
  orgId: number;
  prompt: string;
  subjectType?: string;
  subjectId?: string;
}

export interface CreateSessionResponse {
  sid: string;
  status: SessionStatus;
}

export interface ListSessionsResponse {
  sessions: SessionView[];
}

export type SessionDetailResponse = SessionView;

export interface AnswerPermissionRequest {
  requestId: string;
  decision: "approve" | "reject";
  note?: string;
}

export interface OkResponse {
  ok: true;
}

export interface ErrorEnvelope {
  error: string;
}

/** Gateway 鉴权：除 /healthz 外所有接口要求 `Authorization: Bearer <token>` */
// （契约说明：浏览器不得持有 Gateway 管理 token；经 BFF/Vite 代理注入，见 ARCHITECTURE §6）

// ------------------------------------------------------------------
// 提案生命周期（techhaven-mcp 写提案审批流）
// ------------------------------------------------------------------

/**
 * 提案状态。
 * - pending：已创建，等待人工决定
 * - approved：已批准，等待应用
 * - applying：已被 worker 独占领取、正在执行业务写（审查意见 F2）
 * - applied / rejected / expired：终态
 *
 * appying 是「领取态」而非「决定态」：进入 applying 后人工撤回必须返回冲突，
 * 否则会出现「审批结果说 rejected、业务副作用已发生」的矛盾。
 */
export type ProposalStatus = "pending" | "approved" | "applying" | "rejected" | "applied" | "expired";

export type ProposalLifecycleEventType = "created" | "approved" | "applying" | "rejected" | "applied" | "expired";

/** 浏览器可见的产品写提案快照；不包含内部数字 subject ID。 */
export interface ProposalView {
  id: string;
  sessionId: string;
  orgId: number;
  tool: string;
  subjectType: string;
  subjectHashId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  status: ProposalStatus;
  expiresAt: string;
  updatedAt: string;
  note?: string;
}

/** 产品写提案生命周期；与 runner permission 是两条独立授权链。 */
export interface ProposalLifecycleEvent {
  event: ProposalLifecycleEventType;
  ts: string;
  /** "agent"（发起）/ "user:<id>"（人工决定）/ "system"（自动过期/应用/领取） */
  actor: string;
  proposal: ProposalView;
  note?: string;
}

export interface ListProposalsResponse {
  proposals: ProposalView[];
}

export type ProposalDetailResponse = ProposalView;

export interface DecideProposalRequest {
  decision: "approve" | "reject";
  note?: string;
}
