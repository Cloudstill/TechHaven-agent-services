import { createHash } from "node:crypto";
import { assertTransition } from "../domain/stateMachine.js";
import type { TicketKind, TicketPage, TicketRecord, TrendSummary } from "../domain/types.js";
import { DomainError, type TechHavenClient } from "./client.js";

interface BridgeClientOptions {
  bridgeUrl: string;
  bridgeToken: string;
  sessionId: string;
  orgId: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** MCP → 独立兼容层客户端；旧后端路径、字段、凭据与异常均不再泄漏到 MCP。 */
export class BridgeTechHavenClient implements TechHavenClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: BridgeClientOptions) {
    this.base = opts.bridgeUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.bridgeToken}`,
      "X-TechHaven-Session": this.opts.sessionId,
      "X-TechHaven-Org": String(this.opts.orgId),
      ...extra,
    };
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
        headers: this.headers(init?.headers as Record<string, string> | undefined),
      });
    } catch {
      throw new DomainError(timeoutSignal.aborted ? "BRIDGE_TIMEOUT" : "BRIDGE_UNAVAILABLE", "Agent Bridge 不可用");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DomainError("BRIDGE_BAD_RESPONSE", "Agent Bridge 返回非 JSON");
    }
    if (!response.ok) {
      const error = body && typeof body === "object" ? (body as { error?: { code?: string; message?: string } }).error : undefined;
      throw new DomainError(error?.code ?? "BRIDGE_ERROR", error?.message ?? `Agent Bridge HTTP ${response.status}`);
    }
    return body as T;
  }

  private assertOrg(orgId: number): void {
    if (orgId !== this.opts.orgId) throw new DomainError("ORG_MISMATCH", "工具请求组织与 Agent 会话绑定组织不一致");
  }

  async getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    this.assertOrg(orgId);
    try {
      const body = await this.call<{ ticket: TicketRecord }>(`/internal/v1/tickets/${kind}/${id}`);
      return body.ticket;
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async listTickets(
    orgId: number,
    opts: { kind?: TicketKind; status?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    this.assertOrg(orgId);
    const query = new URLSearchParams();
    if (opts.kind) query.set("kind", opts.kind);
    if (opts.status) query.set("status", opts.status);
    if (opts.page) query.set("page", String(opts.page));
    if (opts.pageSize) query.set("pageSize", String(opts.pageSize));
    return this.call(`/internal/v1/tickets?${query.toString()}`);
  }

  async searchRequirements(
    orgId: number,
    opts: { query?: string; priority?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    this.assertOrg(orgId);
    const query = new URLSearchParams();
    if (opts.query) query.set("query", opts.query);
    if (opts.priority) query.set("priority", opts.priority);
    if (opts.page) query.set("page", String(opts.page));
    if (opts.pageSize) query.set("pageSize", String(opts.pageSize));
    return this.call(`/internal/v1/requirements/search?${query.toString()}`);
  }

  async getTrendSummary(orgId: number, days: number): Promise<TrendSummary> {
    this.assertOrg(orgId);
    return this.call(`/internal/v1/trends?days=${encodeURIComponent(String(days))}`);
  }

  async updateTicketStatus(
    orgId: number,
    kind: TicketKind,
    id: number,
    toStatus: string,
    reason: string,
    options?: { idempotencyKey?: string; expectedFromStatus?: string },
  ): Promise<TicketRecord> {
    this.assertOrg(orgId);
    const current = await this.getTicket(orgId, kind, id);
    if (!current) throw new DomainError("NOT_FOUND", `未找到 ${kind} #${id}`);
    if (current.status !== toStatus) assertTransition(kind, current.status, toStatus as TicketRecord["status"]);
    const idempotencyKey =
      options?.idempotencyKey ??
      `direct:${createHash("sha256").update(`${this.opts.sessionId}:${orgId}:${kind}:${id}:${toStatus}:${reason}`).digest("hex").slice(0, 32)}`;
    const result = await this.call<{ ticket: TicketRecord }>(`/internal/v1/tickets/${kind}/${id}/transition`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        toStatus,
        reason,
        expectedFromStatus: options?.expectedFromStatus ?? current.status,
      }),
    });
    return result.ticket;
  }
}
