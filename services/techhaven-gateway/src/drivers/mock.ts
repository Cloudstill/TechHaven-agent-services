/**
 * 脚本化引擎驱动（mock）：不拉起真实引擎，按固定剧本产出事件，
 * 用于演示 / 测试网关的会话闭环（事件桥 + 权限中继，TH-RFC-001 §05.1）。
 *
 * 剧本（每会话一次性"引擎"）：
 *   running → 读上下文 chunk → tool_call get_ticket → tool_result
 *   → chunk（建议改状态）→ awaiting_permission → permission_request【挂起等应答】
 *     approve → running → tool_call update_ticket_status → tool_result → chunk → succeeded
 *     reject  → chunk（已取消）→ cancelled
 *   cancel() 任意时刻触发 → cancelled；dispose() 随时幂等终止。
 *
 * 真实 dsh 驱动按同一 src/types.ts 契约实现，见 drivers/dsh.ts。
 */
import { randomBytes } from "node:crypto";
import { log } from "../log.js";
import { errorMessage, nowIso, sha256Hex16, sleep } from "../util.js";
import { EventChannel } from "../channel.js";
import type { EngineDriver, EngineEvent, EngineSessionHandle, EngineRuntimeConfig } from "../types.js";

/** 剧本步骤间停顿：让事件呈"流式"到达（0 也合法，便于测试提速） */
const STEP_DELAY_MS = 30;

/** 内部哨兵：用户取消（剧本应在最近检查点退出并产出 cancelled 终态） */
class Cancelled extends Error {
  constructor() {
    super("用户取消");
    this.name = "Cancelled";
  }
}

/** 内部哨兵：网关 dispose（静默退出，不再产出任何事件） */
class Disposed extends Error {
  constructor() {
    super("已释放");
    this.name = "Disposed";
  }
}

interface PermissionDecision {
  decision: "approve" | "reject";
  note?: string;
}

/** 一次 mock 会话：即一个按剧本推进的一次性"引擎"句柄 */
class MockSession implements EngineSessionHandle {
  /** 事件通道：组合共享 EventChannel（单趟游标模式；语义见 src/channel.ts） */
  private readonly queue = new EventChannel<EngineEvent>();
  private seq = 0;
  private cancelled = false;
  private disposed = false;
  private finished = false; // 剧本已走到结束（终态已产出或被 dispose 中止）
  private terminalEmitted = false;
  private pending: { requestId: string; resolve: (d: PermissionDecision | null) => void } | null = null;

  constructor(
    private readonly opts: { sessionId: string; orgId: number; prompt: string; profile?: string },
    private readonly onDone?: () => void,
  ) {
    // 剧本在后台推进；异常全部就地兜底，绝不外抛影响网关进程
    void this.runScript()
      .catch((err) => log(`mock 会话剧本异常（${this.opts.sessionId}）：`, err))
      .finally(() => this.onDone?.());
  }

  events(): AsyncIterable<EngineEvent> {
    // 单消费者（注册表泵）一次消费到结束：replay:false 与回放等价
    return this.queue.iterate({ replay: false });
  }

  async send(text: string): Promise<void> {
    // mock 不消费追加输入（真实驱动由 dsh 会话承接 steer / send）
    log(`mock 会话收到 send（忽略）：${text.slice(0, 50)}`);
  }

  async answerPermission(requestId: string, decision: "approve" | "reject", note?: string): Promise<void> {
    if (this.disposed || this.finished) {
      throw new Error(`会话已结束，无法应答权限请求：${requestId}`);
    }
    const waiting = this.pending;
    if (!waiting || waiting.requestId !== requestId) {
      throw new Error(`未知或已应答的权限请求：${requestId}`);
    }
    this.pending = null;
    waiting.resolve({ decision, note });
  }

  async cancel(): Promise<void> {
    if (this.disposed || this.finished || this.cancelled) return;
    this.cancelled = true;
    // 正挂在等审批处则立即唤醒；否则剧本在下一个检查点自行退出
    const waiting = this.pending;
    if (waiting) {
      this.pending = null;
      waiting.resolve(null);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; // 幂等
    this.disposed = true;
    const waiting = this.pending;
    if (waiting) {
      this.pending = null;
      waiting.resolve(null);
    }
    // 立即终止订阅者的事件流；剧本在下一个检查点静默退出
    this.queue.close();
  }

  /** 剧本主体：所有 await 点之后都经过 checkpoint，保证取消 / 释放即时生效 */
  private async runScript(): Promise<void> {
    try {
      await this.checkpoint();
      this.push({ type: "status_change", ...this.stamp(), status: "running", detail: "mock 引擎已就绪" });

      await this.checkpoint();
      this.push({ type: "assistant_chunk", ...this.stamp(), text: "正在读取缺陷上下文…" });

      const readArgs = { kind: "bug", orgId: this.opts.orgId };
      await this.checkpoint();
      this.push({
        type: "tool_call",
        ...this.stamp(),
        tool: "mcp__techhaven__get_ticket",
        argsDigest: sha256Hex16(readArgs),
        args: readArgs,
      });

      await this.checkpoint();
      this.push({ type: "tool_result", ...this.stamp(), tool: "mcp__techhaven__get_ticket", ok: true, summary: "读取到 1 张缺陷" });

      await this.checkpoint();
      this.push({ type: "assistant_chunk", ...this.stamp(), text: "建议将状态变更为 accepted，需要批准。" });

      const requestId = `req_${randomBytes(6).toString("hex")}`;
      this.push({ type: "status_change", ...this.stamp(), status: "awaiting_permission", detail: "等待人工审批" });
      this.push({
        type: "permission_request",
        ...this.stamp(),
        requestId,
        tool: "mcp__techhaven__update_ticket_status",
        reason: "写操作需人工审批（TH-RFC-001 §07）",
      });

      // —— 在此挂起，直到 answerPermission / cancel / dispose 唤醒 ——
      const decision = await this.waitForDecision(requestId);
      if (this.disposed) return;
      if (this.cancelled || decision === null) {
        this.emitTerminal("cancelled", "用户取消");
        return;
      }

      if (decision.decision === "approve") {
        this.push({ type: "status_change", ...this.stamp(), status: "running", detail: "审批通过，继续执行" });
        const writeArgs = { kind: "bug", to_status: "accepted", reason: decision.note ?? "agent 建议：复现确认，接受进入处理" };
        this.push({
          type: "tool_call",
          ...this.stamp(),
          tool: "mcp__techhaven__update_ticket_status",
          argsDigest: sha256Hex16(writeArgs),
          args: writeArgs,
        });
        await this.checkpoint();
        this.push({
          type: "tool_result",
          ...this.stamp(),
          tool: "mcp__techhaven__update_ticket_status",
          ok: true,
          summary: "缺陷状态已变更为 accepted",
        });
        this.push({ type: "assistant_chunk", ...this.stamp(), text: "已完成。" });
        this.emitTerminal("succeeded");
      } else {
        this.push({ type: "assistant_chunk", ...this.stamp(), text: "已取消。" });
        this.emitTerminal("cancelled", decision.note ? `权限被拒绝：${decision.note}` : "权限被拒绝");
      }
    } catch (err) {
      if (err instanceof Disposed) return; // dispose 中止：不产出任何事件
      if (err instanceof Cancelled) {
        this.emitTerminal("cancelled", "用户取消");
        return;
      }
      // 其他异常：错误事件 + failed 终态（剧本自洽，不外抛）
      this.push({ type: "error", ...this.stamp(), message: errorMessage(err) });
      this.emitTerminal("failed", "mock 剧本异常");
    } finally {
      this.finished = true;
      this.queue.close();
    }
  }

  /** 每个等待点之后调用：发现取消 / 释放即抛哨兵，终止剧本 */
  private async checkpoint(): Promise<void> {
    await sleep(STEP_DELAY_MS);
    if (this.disposed) throw new Disposed();
    if (this.cancelled) throw new Cancelled();
  }

  private waitForDecision(requestId: string): Promise<PermissionDecision | null> {
    return new Promise((resolve) => {
      this.pending = { requestId, resolve };
    });
  }

  /** 自动补 seq（会话内单调递增）与 ts（ISO） */
  private stamp(): { seq: number; ts: string } {
    return { seq: ++this.seq, ts: nowIso() };
  }

  private push(ev: EngineEvent): void {
    this.queue.push(ev);
  }

  private emitTerminal(status: "succeeded" | "failed" | "cancelled", detail?: string): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.push({ type: "status_change", ...this.stamp(), status, detail });
  }
}

/** mock 驱动：按需创建一次性 mock 会话 */
export class MockDriver implements EngineDriver {
  readonly name = "mock";

  private readonly sessions = new Set<MockSession>();

  async startSession(opts: {
    sessionId: string;
    orgId: number;
    prompt: string;
    profile?: string;
    runtimeConfig?: EngineRuntimeConfig;
  }): Promise<EngineSessionHandle> {
    await opts.runtimeConfig?.recordUsage?.(opts.sessionId, "mock-request", { requests: 1 });
    const session = new MockSession(opts, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    const live = [...this.sessions];
    this.sessions.clear();
    await Promise.allSettled(live.map((s) => s.dispose()));
  }
}
