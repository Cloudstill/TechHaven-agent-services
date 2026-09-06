import type { TicketKind, TicketPage, TicketRecord, TrendSummary } from "../domain/types.js";

/** 域层业务错误（工具层把它转成对 agent 友好的错误响应） */
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/**
 * TechHaven 域数据访问接口。
 * mock 实现：离线演示（P0 默认）；http 实现：调用真实后端（待朋友侧 agent-token/服务凭据就绪后启用）。
 */
export interface TechHavenClient {
  getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null>;
  listTickets(orgId: number, opts: { kind?: TicketKind; status?: string; page?: number; pageSize?: number }): Promise<TicketPage>;
  searchRequirements(
    orgId: number,
    opts: { query?: string; priority?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage>;
  getTrendSummary(orgId: number, days: number): Promise<TrendSummary>;
  updateTicketStatus(
    orgId: number,
    kind: TicketKind,
    id: number,
    toStatus: string,
    reason: string,
    options?: { idempotencyKey?: string; expectedFromStatus?: string },
  ): Promise<TicketRecord>;
}
