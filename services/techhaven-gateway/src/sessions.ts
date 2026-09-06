import { isTerminalStatus, sessionPatch, RECOVERED_PROMPT, insertBySeq, readSessionHistory } from "./sessionHistory.js";
/**
 * 会话注册表（TH-RFC-001 §05.1）：会话生命周期 / 配额 / 事件泵 / JSONL 落盘 / SSE 订阅。
 *
 * 数据流：driver.startSession（后台）→ 泵消费 handle.events()
 *   → 内存缓存（按 seq 有序）+ gateway.jsonl append → 唤醒 SSE 订阅者。
 * 终态（succeeded / failed / cancelled）后 dispose 引擎句柄并关闭全部 SSE；
 * 终态驻留超 sessionRetentionMinutes 后从注册表淘汰；空闲超 sessionIdleTimeoutMinutes
 * 由看门狗合成 failed 终态 —— "会话不悬空"的不变量由注册表持有，不依赖驱动流结束。
 */
import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "./log.js";
import { errorMessage, nowIso } from "./util.js";
import type {
  EngineDriver,
  EngineEvent,
  EngineEventPayload,
  EngineRuntimeConfig,
  EngineSessionHandle,
  EventEnvelope,
  ProposalLifecycleEvent,
  SessionStatus,
} from "./types.js";
import { PgQuotaError, type GatewayPgStore, type PersistedGatewaySession } from "./pgStore.js";
import { withSessionMcpContext } from "./mcpLaunchContext.js";

/** 事件信封（TH-RFC-001 §6）：seq/type/occurredAt 上提，payload 保留事件其余字段；SSE 数据帧装信封，JSONL 仍装引擎事件 */
export function toEnvelopeJson(record: SessionRecord, ev: EngineEvent): string {
  const { seq, type, ts, ...payload } = ev;
  // type ↔ payload 的关联来自同一个 ev（构造不变量），离散联合的关联性由约定保证
  const envelope = {
    schemaVersion: 1,
    eventId: `${record.sid}:${seq}`,
    sessionId: record.sid,
    orgId: record.orgId,
    seq,
    type,
    occurredAt: ts,
    traceId: "",
    payload: payload as EngineEventPayload,
  } as EventEnvelope;
  return JSON.stringify(envelope);
}

/** 带 HTTP 语义的业务错误（http.ts 统一映射为 {error}） */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 配额超限 → 429 */
class QuotaError extends GatewayError {
  constructor(message: string) {
    super(429, message);
    this.name = "QuotaError";
  }
}

/** 未知会话 → 404 */
class SessionNotFoundError extends GatewayError {
  constructor(sid: string) {
    super(404, `未知会话：${sid}`);
    this.name = "SessionNotFoundError";
  }
}

/** 会话状态不合法（如未知 requestId、终态后操作）→ 400 */
class SessionStateError extends GatewayError {
  constructor(message: string) {
    super(400, message);
    this.name = "SessionStateError";
  }
}

/** SSE 订阅者回调（http.ts 实现，registry 只负责按序调用）。
 *  onEvent 收到的是已序列化的 SSE 帧串（含 id/data 行，事件只 stringify 一次），直接 res.write 即可 */
export interface SessionEventSubscriber {
  onEvent(frame: string): void;
  onEnd(): void;
}

interface CreateSessionInput {
  ownerActor?: string;
  orgId: number;
  subjectType?: string;
  subjectId?: string;
  prompt: string;
  /** 仅内存传给 driver；绝不进入持久化与客户端视图。 */
  runtimeConfig?: EngineRuntimeConfig;
}

/** 注册表内部会话记录（含句柄 / 订阅者等运行态，禁止直接下发给客户端） */
export interface SessionRecord {
  ownerActor?: string;
  sid: string;
  orgId: number;
  subjectType?: string;
  subjectId?: string;
  prompt: string;
  /** 仅在 driver 启动前短暂保留；pump 取走后立即清空。 */
  runtimeConfig?: EngineRuntimeConfig;
  /** 初始 queued，由事件流里的 status_change 更新 */
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  /** 引擎事件缓存（按 seq 升序，含网关侧合成的终态兜底事件）；驻留淘汰时随记录一并释放 */
  events: EngineEvent[];
  /** SSE 订阅者（仅注册表内部使用） */
  subscribers: Set<SessionEventSubscriber>;
  /** 引擎句柄；startSession 完成前为空 */
  handle?: EngineSessionHandle;
  /** cancel 早于句柄就绪时先记账，句柄就绪后补发 */
  cancelRequested?: boolean;
  /** 终态收尾（dispose + 关闭 SSE）是否已执行 */
  closed?: boolean;
}

/** 客户端可见的会话视图（剥掉句柄 / 订阅者 / 事件缓存） */
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

export function sessionView(record: SessionRecord): SessionView {
  return {
    sid: record.sid,
    orgId: record.orgId,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    prompt: record.prompt,
    status: record.status,
    createdAt: record.createdAt,
    endedAt: record.endedAt,
  };
}

function lastSeq(record: SessionRecord): number {
  return record.events.length > 0 ? record.events[record.events.length - 1].seq : 0;
}

export interface RegistryOptions {
  dataDir: string;
  maxSessionsPerOrg: number;
  /** 终态会话驻留分钟数：到点从注册表淘汰（0 = 不淘汰） */
  sessionRetentionMinutes: number;
  /** 会话空闲超时分钟数：超时合成 failed 终态（0 = 关闭看门狗） */
  sessionIdleTimeoutMinutes: number;
  /** 设置后 PostgreSQL 是 session/event 权威，JSONL 仅作提交后的 spool。 */
  pgStore?: GatewayPgStore;
}

export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>();
  private readonly jsonlPath: string;
  /** 常驻 JSONL 写流（构造期就绪）；初始化失败时为空，落盘降级为仅日志 */
  private jsonl: WriteStream | undefined;
  private jsonlEnded = false;
  /** 单组织活动会话计数（create +1，终态 -1；终态不计入配额） */
  private readonly activeCounts = new Map<number, number>();
  /** 终态驻留淘汰定时器（sid → timer） */
  private readonly retentionTimers = new Map<string, NodeJS.Timeout>();
  /** 会话空闲看门狗（sid → timer） */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** 未完成的 handle.dispose()，registry.dispose() 时统一等待 */
  private readonly pendingDisposes = new Set<Promise<void>>();
  /** driver / proposal / watchdog 可并发产生日志；逐会话串行化后由 Gateway 统一分配 seq。 */
  private readonly eventTails = new Map<string, Promise<void>>();
  private startupInterrupted: SessionRecord[] = [];

  constructor(
    private readonly driver: EngineDriver,
    private readonly opts: RegistryOptions,
  ) {
    this.jsonlPath = join(opts.dataDir, "gateway.jsonl");
    try {
      mkdirSync(opts.dataDir, { recursive: true });
      const interrupted = opts.pgStore ? [] : this.restoreFromJsonl();
      this.startupInterrupted = interrupted;
      this.jsonl = createWriteStream(this.jsonlPath, { flags: "a" });
      this.jsonl.on("error", (err) => log(`JSONL 写入失败（${this.jsonlPath}）：`, err));
    } catch (err) {
      // 目录 / 写流不可用：落盘降级，内存事件流与 SSE 分发不受影响
      log(`JSONL 落盘不可用（${this.jsonlPath}）：`, err);
    }
  }

  /** 异步装载权威存储；调用方必须在监听端口前 await。 */
  static async open(driver: EngineDriver, opts: RegistryOptions): Promise<SessionRegistry> {
    const registry = new SessionRegistry(driver, opts);
    await registry.initialize();
    return registry;
  }

  private async initialize(): Promise<void> {
    if (this.opts.pgStore) {
      const restored = await this.opts.pgStore.restore(this.opts.sessionRetentionMinutes);
      for (const source of restored) this.restorePgRecord(source);
      this.startupInterrupted = [...this.records.values()].filter((record) => !isTerminalStatus(record.status));
      if (restored.length > 0) {
        log(`PostgreSQL 恢复：sessions=${restored.length} interrupted=${this.startupInterrupted.length}`);
      }
    }
    const interrupted = this.startupInterrupted;
    this.startupInterrupted = [];
    for (const record of interrupted) {
      await this.publishEvent(record, {
        type: "status_change",
        seq: 0,
        ts: nowIso(),
        status: "failed",
        detail: "Gateway 重启，运行态引擎句柄不可恢复",
      });
    }
  }

  private restorePgRecord(source: PersistedGatewaySession): void {
    const record: SessionRecord = {
      sid: source.sid,
      ownerActor: source.ownerActor,
      orgId: source.orgId,
      subjectType: source.subjectType,
      subjectId: source.subjectId,
      prompt: RECOVERED_PROMPT,
      status: source.status,
      createdAt: source.createdAt,
      endedAt: source.endedAt,
      events: [],
      subscribers: new Set(),
      closed: isTerminalStatus(source.status),
    };
    for (const event of source.events) insertBySeq(record, event);
    let remaining: number | undefined;
    if (record.closed && record.endedAt && this.opts.sessionRetentionMinutes > 0) {
      remaining = this.opts.sessionRetentionMinutes * 60_000 - (Date.now() - Date.parse(record.endedAt));
      if (!Number.isFinite(remaining) || remaining <= 0) return;
    }
    this.records.set(record.sid, record);
    if (record.closed) this.armRetention(record, remaining);
  }

  private restoreFromJsonl(): SessionRecord[] {
    const interrupted: SessionRecord[] = [];
    for (const { record, retentionMs } of readSessionHistory(this.jsonlPath, this.opts.sessionRetentionMinutes)) {
      this.records.set(record.sid, record);
      if (record.closed) this.armRetention(record, retentionMs);
      else interrupted.push(record);
    }
    return interrupted;
  }

  /**
   * 创建会话：配额检查 + 登记 + 后台启动引擎（不阻塞返回）。
   * JSONL 模式依赖单进程同步登记；PG 模式用 advisory transaction lock + 权威计数防多实例竞态。
   */
  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const active = this.activeCountByOrg(input.orgId);
    if (active >= this.opts.maxSessionsPerOrg) {
      throw new QuotaError(`组织 ${input.orgId} 活动会话数已达配额（${active}/${this.opts.maxSessionsPerOrg}）`);
    }
    const sid = `s_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const record: SessionRecord = {
      sid,
      ownerActor: input.ownerActor,
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      prompt: input.prompt,
      runtimeConfig: input.runtimeConfig,
      status: "queued",
      createdAt: nowIso(),
      events: [],
      subscribers: new Set(),
    };
    if (this.opts.pgStore) {
      try {
        await this.opts.pgStore.createSession(record, this.opts.maxSessionsPerOrg);
      } catch (error) {
        if (error instanceof PgQuotaError) throw new QuotaError(error.message);
        throw error;
      }
    }
    this.records.set(sid, record);
    this.bumpActive(record.orgId, 1);
    // MCP 启动上下文与「已授权 org + 本次 sid」绑定：dsh 子进程的 env 会整体替换父环境，
    // 随附的 dsh MCP 配置只能从这里拿到凭据与会话归属（审查意见 F6）。
    if (record.runtimeConfig) {
      withSessionMcpContext(record.runtimeConfig, { sid, orgId: record.orgId });
    }
    // patch 行带全量归属（orgId/subjectType/subjectId 供装载器落 agent_sessions / agent_identities）；
    // 中途状态变化不写 patch 行（kind:"event" 行已含 status），归属以首行为准
    this.appendJsonl(JSON.stringify({ kind: "session", sid, patch: sessionPatch(record, record.status) }));
    // 看门狗自创建即生效：startSession 悬死也能被空闲超时收尾
    this.resetIdleTimer(record);
    // 后台启动：泵自管异常，绝不外抛
    void this.pump(record);
    return record;
  }

  get(sid: string): SessionRecord | undefined {
    return this.records.get(sid);
  }

  /** 全量会话（按创建时间升序） */
  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sid.localeCompare(b.sid));
  }

  /**
   * 把产品 proposal 当前生命周期同步进会话事件流。相同提案同一状态只发布一次；
   * sid/org 任一不匹配均按未知会话处理，避免跨组织枚举。
   */
  async syncProposalLifecycle(lifecycle: ProposalLifecycleEvent): Promise<void> {
    const proposal = lifecycle.proposal;
    const record = this.records.get(proposal.sessionId);
    if (!record || record.orgId !== proposal.orgId) throw new SessionNotFoundError(proposal.sessionId);
    const previous = [...record.events]
      .reverse()
      .find((event) => event.type === "proposal_lifecycle" && event.proposal.id === proposal.id);
    if (previous?.type === "proposal_lifecycle" && previous.proposal.status === proposal.status) return;
    await this.publishEvent(record, {
      type: "proposal_lifecycle",
      seq: 0,
      ts: lifecycle.ts,
      event: lifecycle.event,
      actor: lifecycle.actor,
      proposal,
      ...(lifecycle.note ? { note: lifecycle.note } : {}),
    });
  }

  /** 活动会话数：queued / running / awaiting_permission 计入，终态不计（per-org 增量计数，替代全表扫描） */
  activeCountByOrg(orgId: number): number {
    return this.activeCounts.get(orgId) ?? 0;
  }

  async checkReady(): Promise<void> {
    await this.opts.pgStore?.ping();
  }

  /** per-org 活动计数增量维护（负向钳制在 0，防异常路径多减成负数） */
  private bumpActive(orgId: number, delta: 1 | -1): void {
    const next = Math.max(0, (this.activeCounts.get(orgId) ?? 0) + delta);
    if (next === 0) this.activeCounts.delete(orgId);
    else this.activeCounts.set(orgId, next);
  }

  /** 权限中继：路由到引擎句柄，并落一条 JSONL 审计行 */
  async answerPermission(sid: string, requestId: string, decision: "approve" | "reject", note?: string): Promise<void> {
    const record = this.requireRecord(sid);
    if (isTerminalStatus(record.status)) {
      throw new SessionStateError(`会话已结束（${record.status}），无法应答权限请求`);
    }
    const handle = record.handle;
    if (!handle) throw new SessionStateError("引擎尚未就绪，无法应答权限请求，请稍后重试");
    try {
      await handle.answerPermission(requestId, decision, note);
    } catch (err) {
      // registry 自有状态检查（上方 400）之外的驱动侧错误：完整原始错误进日志，运维细节不直达 API 客户端
      log(`权限应答被引擎拒绝（${sid}，requestId=${requestId}）：${errorMessage(err)}`);
      throw new GatewayError(502, "上游引擎拒绝");
    }
    // 审计行补 orgId（装载器可按组织归档）；权限工具调用的权威台账仍在 techhaven-mcp 侧
    this.appendJsonl(JSON.stringify({ kind: "permission", sid, orgId: record.orgId, requestId, decision, ts: nowIso() }));
  }

  /** 用户取消（幂等：已终态直接视为成功） */
  async cancel(sid: string): Promise<void> {
    const record = this.requireRecord(sid);
    if (isTerminalStatus(record.status)) return;
    record.cancelRequested = true;
    const handle = record.handle;
    if (handle) {
      try {
        await handle.cancel();
      } catch (err) {
        // 驱动侧错误同样归一为 502，原始错误只进日志
        log(`取消会话被引擎拒绝（${sid}）：${errorMessage(err)}`);
        throw new GatewayError(502, "上游引擎拒绝");
      }
    }
    // 句柄未就绪：cancelRequested 已记账，泵在句柄就绪后补发 cancel
  }

  /** 注册 SSE 订阅者；会话已收尾时立即回调 onEnd（补发缓存由 HTTP 层负责，且在本调用之前） */
  subscribe(record: SessionRecord, subscriber: SessionEventSubscriber): void {
    record.subscribers.add(subscriber);
    if (record.closed) subscriber.onEnd();
  }

  unsubscribe(record: SessionRecord, subscriber: SessionEventSubscriber): void {
    record.subscribers.delete(subscriber);
  }

  /** 优雅关闭：dispose 全部句柄并关闭全部 SSE 订阅，清空看门狗 / 驻留定时器，冲刷 JSONL 写流 */
  async dispose(): Promise<void> {
    for (const record of this.records.values()) this.closeSession(record);
    await Promise.allSettled([...this.eventTails.values()]);
    this.eventTails.clear();
    await Promise.allSettled([...this.pendingDisposes]);
    this.pendingDisposes.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const timer of this.retentionTimers.values()) clearTimeout(timer);
    this.retentionTimers.clear();
    // 进程退出路径（SIGINT/SIGTERM → registry.dispose）：尽力 end 写流冲刷剩余行
    this.endJsonl();
    await this.opts.pgStore?.close();
  }

  private requireRecord(sid: string): SessionRecord {
    const record = this.records.get(sid);
    if (!record) throw new SessionNotFoundError(sid);
    return record;
  }

  /** 事件泵：消费引擎事件流直到结束；任何异常都收敛为 failed 终态，绝不让进程崩 */
  private async pump(record: SessionRecord): Promise<void> {
    try {
      const runtimeConfig = record.runtimeConfig;
      record.runtimeConfig = undefined;
      await runtimeConfig?.recordUsage?.(record.sid, "session", { sessions: 1 });
      const handle = await this.driver.startSession({
        sessionId: record.sid,
        orgId: record.orgId,
        prompt: record.prompt,
        // profile 由 Gateway 经驱动构造器统一下发（单通道，见 RegistryOptions 注释）
        runtimeConfig,
      });
      record.handle = handle;
      // cancel 早于句柄就绪到达：补发
      if (record.cancelRequested && !isTerminalStatus(record.status)) {
        void handle.cancel().catch((err) => log(`补发 cancel 失败（${record.sid}）：`, err));
      }
      for await (const ev of handle.events()) {
        await this.publishEvent(record, ev);
      }
      if (!isTerminalStatus(record.status)) {
        if (record.closed) {
          // 注册表主动 dispose 导致的流结束：不合成 failed（不撒谎），仅留痕
          log(`会话 ${record.sid} 事件流在注册表释放后结束（状态 ${record.status}），不合成终态`);
          this.appendJsonl(
            JSON.stringify({
              kind: "session",
              sid: record.sid,
              patch: sessionPatch(record, record.status, "注册表释放导致事件流结束"),
            }),
          );
        } else {
          // 流异常结束但未见终态 → 网关侧合成 failed，绝不让会话悬空
          await this.publishEvent(record, {
            type: "status_change",
            seq: 0,
            ts: nowIso(),
            status: "failed",
            detail: "事件流在非终态下结束",
          });
        }
      }
    } catch (err) {
      // 完整原始错误（含安装指引等运维细节）只进日志
      log(`会话事件泵异常（${record.sid}）：`, err);
      if (!isTerminalStatus(record.status)) {
        try {
          await this.publishEvent(record, {
            type: "status_change",
            seq: 0,
            ts: nowIso(),
            status: "failed",
            // 面向消费者的归因一句话；细节见上方日志
            detail: record.handle === undefined ? "引擎会话启动失败" : "引擎事件流异常中断",
          });
        } catch (persistError) {
          // PG 权威不可用时绝不把未提交终态展示成事实；重启恢复会再次收敛活动会话。
          log(`会话失败终态无法提交权威存储（${record.sid}）：`, persistError);
        }
      }
    } finally {
      this.closeSession(record);
    }
  }

  /**
   * 新事件统一入口：driver 自带 seq 只是 adapter 内部顺序提示；真正的会话 seq 由 Gateway
   * 在串行队列内分配，确保 proposal / watchdog 与 driver 并发时仍无冲突、无缺口。
   */
  private publishEvent(record: SessionRecord, source: EngineEvent): Promise<void> {
    const previous = this.eventTails.get(record.sid) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.acceptEvent(record, { ...source, seq: lastSeq(record) + 1 } as EngineEvent));
    this.eventTails.set(record.sid, next);
    next.then(
      () => {
        if (this.eventTails.get(record.sid) === next) this.eventTails.delete(record.sid);
      },
      () => {
        if (this.eventTails.get(record.sid) === next) this.eventTails.delete(record.sid);
      },
    );
    return next;
  }

  /** 已分配 seq 的事件落点：缓存 + JSONL + 状态机 + 唤醒 SSE；终态时收尾会话 */
  private async acceptEvent(record: SessionRecord, ev: EngineEvent): Promise<void> {
    if (this.opts.pgStore) {
      const inserted = await this.opts.pgStore.appendEvent(record.sid, ev);
      if (!inserted) {
        log(`忽略 PostgreSQL 已存在事件（${record.sid}，seq=${ev.seq}）`);
        return;
      }
    }
    if (!insertBySeq(record, ev)) {
      log(`忽略重复引擎事件（${record.sid}，seq=${ev.seq}）`);
      return;
    }
    // 每事件只 JSON.stringify 一次：eventJson 复用于 SSE 帧串与 JSONL 行串各一份，分发不再逐订阅者序列化
    const eventJson = JSON.stringify(ev);
    const frame = `id: ${ev.seq}\ndata: ${toEnvelopeJson(record, ev)}\n\n`;
    this.appendJsonl(`{"kind":"event","sid":${JSON.stringify(record.sid)},"event":${eventJson}}`);
    // 看门狗：任何事件都证明会话活跃，重置空闲计时
    if (!record.closed && !isTerminalStatus(record.status)) this.resetIdleTimer(record);

    if (ev.type === "status_change" && ev.status !== record.status) {
      const wasTerminal = isTerminalStatus(record.status);
      record.status = ev.status;
      if (isTerminalStatus(ev.status)) {
        record.endedAt = ev.ts;
        if (!wasTerminal) this.bumpActive(record.orgId, -1);
      }
      // kind:"event" 行已含 status，不再双写派生的 session patch 行
    }

    // 唤醒 SSE 订阅者：同步回调 + 单个异常只摘除该订阅者
    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber.onEvent(frame);
      } catch (err) {
        log(`SSE 订阅者异常，摘除（${record.sid}）：`, err);
        record.subscribers.delete(subscriber);
      }
    }

    if (ev.type === "status_change" && isTerminalStatus(ev.status)) {
      this.armRetention(record);
      this.closeSession(record);
    }
  }

  /** 终态 / 关停收尾（幂等）：dispose 引擎句柄 + 关闭全部 SSE 订阅者 + 摘除看门狗 */
  private closeSession(record: SessionRecord): void {
    if (record.closed) return;
    record.closed = true;

    const idleTimer = this.idleTimers.get(record.sid);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(record.sid);
    }

    const handle = record.handle;
    record.handle = undefined;
    if (handle) {
      const disposing: Promise<void> = handle
        .dispose()
        .catch((err) => log(`引擎句柄 dispose 失败（${record.sid}）：`, err))
        .finally(() => this.pendingDisposes.delete(disposing));
      this.pendingDisposes.add(disposing);
    }

    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber.onEnd();
      } catch (err) {
        log(`SSE 订阅者 onEnd 异常（${record.sid}）：`, err);
      }
    }
    record.subscribers.clear();
  }

  /** 终态驻留淘汰：到点移除注册表条目（事件缓存随记录一并释放）；0 = 不淘汰 */
  private armRetention(record: SessionRecord, restoredDelayMs?: number): void {
    const minutes = this.opts.sessionRetentionMinutes;
    if (minutes <= 0) return;
    const existing = this.retentionTimers.get(record.sid);
    if (existing) clearTimeout(existing);
    const delayMs = restoredDelayMs ?? minutes * 60_000;
    const timer = setTimeout(() => {
      this.retentionTimers.delete(record.sid);
      this.records.delete(record.sid);
      this.eventTails.delete(record.sid);
      log(`会话 ${record.sid} 终态驻留超 ${minutes} 分钟，已从注册表淘汰`);
    }, delayMs);
    timer.unref(); // 驻留清理不阻止进程退出
    this.retentionTimers.set(record.sid, timer);
  }

  /** 空闲看门狗：创建 / 每事件时重置；超时走既有终态路径合成 failed（SSE + JSONL + dispose） */
  private resetIdleTimer(record: SessionRecord): void {
    const minutes = this.opts.sessionIdleTimeoutMinutes;
    if (minutes <= 0) return; // 0 = 关闭看门狗
    const existing = this.idleTimers.get(record.sid);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleTimers.delete(record.sid);
      if (record.closed || isTerminalStatus(record.status)) return;
      log(`会话 ${record.sid} 空闲超时（${minutes} 分钟无引擎事件），合成 failed 终态`);
      void this.publishEvent(record, {
        type: "status_change",
        seq: 0,
        ts: nowIso(),
        status: "failed",
        detail: "空闲超时，引擎无事件",
      }).catch((err) => log(`空闲超时终态无法提交（${record.sid}）：`, err));
    }, minutes * 60_000);
    timer.unref(); // 看门狗不阻止进程退出（监听中的 HTTP 服务自持进程存活）
    this.idleTimers.set(record.sid, timer);
  }

  /** JSONL append-only 审计落盘（≈ services/techhaven-mcp/src/audit.ts 的 AuditLog.append，孪生实现防漂移）。
   *  行串由调用方序列化（acceptEvent 复用事件 JSON），此处只写常驻流；写失败仅记日志，不影响内存事件流与 SSE */
  private appendJsonl(lineJson: string): void {
    if (this.jsonlEnded) return;
    try {
      this.jsonl?.write(`${lineJson}\n`);
    } catch (err) {
      log(`JSONL 写入失败（${this.jsonlPath}）：`, err);
    }
  }

  /** 进程退出路径尽力冲刷：end 写流（后续 append 静默忽略） */
  private endJsonl(): void {
    if (this.jsonlEnded) return;
    this.jsonlEnded = true;
    this.jsonl?.end();
  }
}
