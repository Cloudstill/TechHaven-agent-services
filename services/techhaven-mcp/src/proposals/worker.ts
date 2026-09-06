import { assertTransition } from "../domain/stateMachine.js";
import type { TicketStatus } from "../domain/types.js";
import { log } from "../log.js";
import type { TechHavenClient } from "../techhaven/client.js";
import type { ProposalApplyOutcome, ProposalDetail, ProposalRepository } from "./store.js";

export interface ProposalWorkerOptions {
  store: ProposalRepository;
  client: TechHavenClient;
  sessionId: string;
  orgId: number;
  intervalMs?: number;
}

/**
 * staged 写提案主动应用 worker。
 *
 * repository 可以是 JSONL PoC 或 PostgreSQL 权威实现：批准后本 worker 重读状态、
 * 重校验域状态并应用。PG 实现用行锁保证多个 worker 只有一个执行域写回调。
 * 单 MCP 进程只处理自身 sid + org 的提案，避免跨会话代执行。
 */
export class ProposalWorker {
  private readonly inFlight = new Set<string>();
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly options: ProposalWorkerOptions) {
    this.intervalMs = Math.max(options.intervalMs ?? 250, 50);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const { detail, status } of await this.options.store.list()) {
        if (detail.sessionId !== this.options.sessionId || detail.orgId !== this.options.orgId) continue;
        if (status === "pending") {
          await this.options.store.getState(detail.id); // 触发超时补记，未批准不执行
          continue;
        }
        // applying = 上次领取后未回填终态（worker 崩溃/失联）；交给 repository 按租约判定能否重新领取
        if (status !== "approved" && status !== "applying") continue;
        if (this.inFlight.has(detail.id)) continue;
        this.inFlight.add(detail.id);
        try {
          await this.options.store.applyApproved(detail.id, (lockedDetail) => this.apply(lockedDetail));
        } finally {
          this.inFlight.delete(detail.id);
        }
      }
    } catch (err) {
      log("proposal worker 轮询失败:", err);
    } finally {
      this.polling = false;
    }
  }

  private async apply(detail: ProposalDetail): Promise<ProposalApplyOutcome> {
    try {
      const current = await this.options.client.getTicket(detail.orgId, detail.kind, detail.subjectId);
      if (!current) {
        return this.reject(detail, "应用失败：工单不存在");
      }

      // 崩溃恢复窗口：域写可能已成功，但 applied 事件尚未来得及落盘。
      // 当前状态已等于目标时只补 applied 留痕，不重复发起写请求。
      if (current.status === detail.toStatus) {
        log(`proposal worker 已对账 ${detail.id}（目标状态已存在）`);
        return { status: "applied", note: "目标状态已存在，恢复时完成对账" };
      }

      assertTransition(detail.kind, current.status, detail.toStatus as TicketStatus);
      await this.options.client.updateTicketStatus(detail.orgId, detail.kind, detail.subjectId, detail.toStatus, detail.reason, {
        idempotencyKey: detail.id,
        expectedFromStatus: current.status,
      });
      log(`proposal worker 已应用 ${detail.id}`);
      return { status: "applied" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "未知应用错误";
      return this.reject(detail, `应用失败：${reason}`);
    }
  }

  private reject(detail: ProposalDetail, reason: string): ProposalApplyOutcome {
    log(`proposal worker 已拒绝 ${detail.id}：${reason}`);
    return { status: "rejected", note: reason };
  }
}
