import { createHash } from "node:crypto";
import { LegacyBackendError } from "./legacyClient.js";
import type { OperationLedger, OperationRecord, OperationStatus } from "./ledger.js";
import type {
  LegacyBackendPort,
  TicketKind,
  TicketPage,
  TicketRecord,
  TransitionInput,
  TransitionResult,
  TrendSummary,
} from "./types.js";

export class BridgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

function digest(input: TransitionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        orgId: input.orgId,
        kind: input.kind,
        id: input.id,
        toStatus: input.toStatus,
        reason: input.reason,
        expectedFromStatus: input.expectedFromStatus,
      }),
    )
    .digest("hex");
}

export class BridgeService {
  /**
   * 同一工单的读—校验—写—确认整段串行。
   *
   * 键是目标工单 (orgId, kind, id)，而**不是** idempotencyKey：两个不同 proposal
   * 带着不同幂等键改同一个工单时，旧的按幂等键排队会让它们并发通过
   * expectedFromStatus 检查，第二次写覆盖第一次（审查意见 F5）。
   * 幂等键仍然用于请求去重与重放，两者职责分离。
   */
  private readonly subjectTails = new Map<string, Promise<TransitionResult>>();

  constructor(
    private readonly legacy: LegacyBackendPort,
    private readonly ledger: OperationLedger,
  ) {}

  getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    return this.legacy.getTicket(orgId, kind, id);
  }

  listTickets(orgId: number, opts: { kind?: TicketKind; status?: string; page?: number; pageSize?: number }): Promise<TicketPage> {
    return this.legacy.listTickets(orgId, opts);
  }

  searchRequirements(
    orgId: number,
    opts: { query?: string; priority?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    return this.legacy.searchRequirements(orgId, opts);
  }

  getTrendSummary(orgId: number, days: number): Promise<TrendSummary> {
    return this.legacy.getTrendSummary(orgId, days);
  }

  transition(input: TransitionInput): Promise<TransitionResult> {
    const subjectKey = `${input.orgId}:${input.kind}:${input.id}`;
    const previous = this.subjectTails.get(subjectKey);
    // 前序操作失败不影响本次排队：每个提案都要基于自己读到的状态重新校验。
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.transitionNow(input));
    this.subjectTails.set(subjectKey, next);
    return next.finally(() => {
      if (this.subjectTails.get(subjectKey) === next) this.subjectTails.delete(subjectKey);
    });
  }

  private operation(input: TransitionInput, requestDigest: string, status: OperationStatus, note?: string): OperationRecord {
    return {
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      sessionId: input.sessionId,
      orgId: input.orgId,
      kind: input.kind,
      subjectId: input.id,
      toStatus: input.toStatus,
      status,
      ts: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
  }

  private async transitionNow(input: TransitionInput): Promise<TransitionResult> {
    const requestDigest = digest(input);
    const existing = this.ledger.get(input.idempotencyKey);
    if (existing && existing.requestDigest !== requestDigest) {
      throw new BridgeError(409, "IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 被用于不同请求");
    }

    if (existing) {
      const current = await this.legacy.getTicket(input.orgId, input.kind, input.id);
      if (!current) throw new BridgeError(404, "NOT_FOUND", "旧后端中未找到目标工单");
      if (existing.status === "confirmed") {
        return this.result(input, current, true, current.status === input.toStatus);
      }
      if (current.status === input.toStatus) {
        this.ledger.append(this.operation(input, requestDigest, "confirmed", "重放时读取到目标状态，完成对账"));
        return this.result(input, current, true, true);
      }
      throw new BridgeError(
        409,
        existing.status === "uncertain" ? "OPERATION_UNCERTAIN" : "OPERATION_NOT_RETRYABLE",
        `操作已处于 ${existing.status}，当前状态仍为 ${current.status}；为避免重复写入，需人工核对或使用新的 proposal`,
      );
    }

    const before = await this.legacy.getTicket(input.orgId, input.kind, input.id);
    if (!before) throw new BridgeError(404, "NOT_FOUND", "旧后端中未找到目标工单");
    if (before.status === input.toStatus) {
      this.ledger.append(this.operation(input, requestDigest, "confirmed", "写前已是目标状态"));
      return this.result(input, before, false, true);
    }
    if (input.expectedFromStatus && before.status !== input.expectedFromStatus) {
      throw new BridgeError(409, "STALE_PRECONDITION", `旧后端当前状态为 ${before.status}，与期望 ${input.expectedFromStatus} 不一致`);
    }

    this.ledger.append(this.operation(input, requestDigest, "started"));
    try {
      await this.legacy.updateTicketStatus(input.orgId, input.kind, input.id, input.toStatus, input.reason, {
        expectedFromStatus: before.status,
      });
      const after = await this.legacy.getTicket(input.orgId, input.kind, input.id);
      if (!after || after.status !== input.toStatus) {
        this.ledger.append(this.operation(input, requestDigest, "uncertain", "旧后端返回成功但写后状态未确认"));
        throw new BridgeError(502, "WRITE_NOT_CONFIRMED", "旧后端写入结果无法确认，已停止自动重试");
      }
      this.ledger.append(this.operation(input, requestDigest, "confirmed"));
      return this.result(input, after, false, false);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // 网络断开/5xx 可能发生在旧后端已提交之后；先读后端对账，再决定是否需要人工介入。
      try {
        const reconciled = await this.legacy.getTicket(input.orgId, input.kind, input.id);
        if (reconciled?.status === input.toStatus) {
          this.ledger.append(this.operation(input, requestDigest, "confirmed", "错误后读取到目标状态，完成对账"));
          return this.result(input, reconciled, false, true);
        }
      } catch {
        // 对账读本身失败，沿用原写错误的不确定性。
      }
      const ambiguous = error instanceof LegacyBackendError ? error.ambiguous : true;
      this.ledger.append(
        this.operation(input, requestDigest, ambiguous ? "uncertain" : "failed", error instanceof Error ? error.message : "未知错误"),
      );
      if (error instanceof LegacyBackendError) {
        throw new BridgeError(error.httpStatus, error.code, error.message);
      }
      throw new BridgeError(502, "LEGACY_WRITE_FAILED", "旧后端写入失败");
    }
  }

  private result(input: TransitionInput, ticket: TicketRecord, replayed: boolean, reconciled: boolean): TransitionResult {
    return {
      ticket,
      operation: {
        idempotencyKey: input.idempotencyKey,
        status: "confirmed",
        replayed,
        reconciled,
      },
    };
  }
}
