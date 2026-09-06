/**
 * 引擎驱动接口契约（TH-RFC-001 §05.1）。
 *
 * 类型单源已迁移至 `techhaven-contracts`（仓库根契约包，见 contracts/README.md）：
 * 本文件仅保留重导出与「逐字冻结」的说明。跨驱动（mock / dsh）与 Gateway、
 * SPA 消费的引擎事件 / 事件信封 / 会话视图 / API 形态都以契约包为准。
 */

import type { EngineEvent, EventEnvelope } from "techhaven-contracts";

export type {
  SessionStatus,
  EngineEvent,
  EngineEventPayload,
  EventEnvelope,
  SessionView,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  SessionDetailResponse,
  AnswerPermissionRequest,
  OkResponse,
  ErrorEnvelope,
  ProposalStatus,
  ProposalLifecycleEvent,
} from "techhaven-contracts";

/** 引擎事件载荷的荷载形状不可变：driver 输出 → 信封 payload 的直接来源 */
// 契约包里的 EngineEvent/EventEnvelope 定义为唯一事实源，改动需双方同步评审（见 contracts/README.md）。

export interface EngineSessionHandle {
  events(): AsyncIterable<EngineEvent>; // 会话全量事件流（含历史回放）
  send(text: string): Promise<void>;
  answerPermission(requestId: string, decision: "approve" | "reject", note?: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 仅在 Gateway 内存中流转的模型运行配置。
 *
 * `env` 可含供应商密钥，因此禁止写入 SessionView、JSONL、日志或 HTTP 响应。
 * dsh driver 必须把不同配置放入相互隔离的 runtime，不能复用进程级环境。
 */
export interface EngineRuntimeConfig {
  /** Server-only accounting callback; never passed into SDK options or child env. */
  recordUsage?: (sessionSid: string, eventKey: string, delta: EngineUsage) => Promise<void>;
  provider: string;
  model: string;
  /** 推理档位（dsh reasoningEffort，非空字符串）；省略用模型默认 */
  reasoningEffort?: string;
  maxTokens?: number;
  env: Record<string, string>;
  /**
   * 会话级 MCP 启动上下文（审查意见 F6）：显式绑定 sid / 已授权 org / 最小 scopes，
   * 并按需携带专用的 MCP 启动凭据。
   *
   * 存在的理由：dsh 的 env 会**整体替换**父环境（docs/DSH_SDK.md §「显式 env」），
   * 而随附的 dsh MCP 配置恰好从 process.env 读取 TECHHAVEN_AGENT_TOKEN /
   * TECHHAVEN_TOKEN_SECRET。不显式传递，启用用户模型配置后 MCP 初始化必然失败。
   * 这里只放最小集合，绝不回退成「继承全部父环境」。
   */
  mcpEnv?: Record<string, string>;
}

export interface EngineUsage {
  sessions?: number;
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costMicros?: number;
}

export interface EngineDriver {
  readonly name: string;
  startSession(opts: {
    sessionId: string;
    orgId: number;
    prompt: string;
    profile?: string;
    runtimeConfig?: EngineRuntimeConfig;
  }): Promise<EngineSessionHandle>;
  dispose(): Promise<void>;
}
