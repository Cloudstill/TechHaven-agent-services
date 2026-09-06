import { assertTransition } from "../domain/stateMachine.js";
import type { TicketKind, TicketPage, TicketRecord, TrendSummary } from "../domain/types.js";
import { DomainError, type TechHavenClient } from "./client.js";

/**
 * 真实后端适配器。端点对齐 TechHaven 前端 src/services/rdPlatformService.ts：
 *   GET  /rd/requirements?page=&page_size=&org_id=&search=&status=&priority=
 *   GET  /rd/requirements/detail?id=
 *   POST /rd/requirements/edit   （body: { id, status, org_id, ... }）
 *   —— bugs / tasks 同构；GET /rd/trends
 *
 * 鉴权：使用服务端到服务端凭据（TECHHAVEN_SERVICE_TOKEN），agent token 不会传给后端。
 * TODO(对齐后端)：朋友侧 P0 交付「agent token 校验/服务凭据」后联调；趋势接口响应结构
 * 以 backend 实际返回为准，本实现的 summary 由列表端点聚合而来（P0 从简）。
 */

interface HttpOpts {
  apiBaseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const KIND_PATH: Record<TicketKind, string> = {
  requirement: "requirements",
  bug: "bugs",
  task: "tasks",
};

export class HttpTechHavenClient implements TechHavenClient {
  private base: string;
  private serviceToken: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: HttpOpts) {
    this.base = opts.apiBaseUrl.replace(/\/+$/, "");
    this.serviceToken = opts.serviceToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.serviceToken ? { Authorization: `Bearer ${this.serviceToken}` } : {}),
          ...init?.headers,
        },
      });
    } catch (error) {
      if (timeoutSignal.aborted) throw new DomainError("UPSTREAM_TIMEOUT", `后端超时：${path}`);
      throw new DomainError("UPSTREAM_UNAVAILABLE", `后端不可用：${path}`);
    }
    if (!res.ok) {
      throw new DomainError("HTTP_ERROR", `后端 ${res.status}：${path}`);
    }
    const body = (await res.json()) as { errno?: number; data?: T; msg?: string; message?: string };
    // TechHaven 后端统一结构：{ errno, data }，errno === 0 为成功
    if (typeof body.errno === "number" && body.errno !== 0) {
      throw new DomainError("BACKEND_ERRNO", body.msg || body.message || `后端错误码 ${body.errno}`);
    }
    return body.data as T;
  }

  private async fetchDetail(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    const raw = await this.call<Record<string, unknown> | null>(
      `/rd/${KIND_PATH[kind]}/detail?id=${encodeURIComponent(String(id))}&org_id=${orgId}`,
    );
    if (!raw) return null;
    return mapRaw(kind, orgId, raw);
  }

  async getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    return this.fetchDetail(orgId, kind, id);
  }

  private async listKind(orgId: number, kind: TicketKind, params: Record<string, string | number | undefined>): Promise<TicketPage> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") q.set(k, String(v));
    }
    q.set("org_id", String(orgId));
    const raw = await this.call<{ list?: Record<string, unknown>[]; total?: number }>(`/rd/${KIND_PATH[kind]}?${q.toString()}`);
    const items = (raw.list ?? []).map((r) => mapRaw(kind, orgId, r));
    return {
      total: raw.total ?? items.length,
      page: Number(params.page ?? 1),
      pageSize: Number(params.page_size ?? 20),
      items,
    };
  }

  async listTickets(
    orgId: number,
    opts: { kind?: TicketKind; status?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    const kinds: TicketKind[] = opts.kind ? [opts.kind] : ["requirement", "bug", "task"];
    const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 50);
    const pages = await Promise.all(
      kinds.map((k) => this.listKind(orgId, k, { status: opts.status, page: opts.page, page_size: pageSize })),
    );
    const items = pages.flatMap((p) => p.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: pages.reduce((n, p) => n + p.total, 0),
      page: opts.page ?? 1,
      pageSize,
      items: items.slice(0, pageSize),
    };
  }

  async searchRequirements(
    orgId: number,
    opts: { query?: string; priority?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    return this.listKind(orgId, "requirement", {
      search: opts.query,
      priority: opts.priority,
      page: opts.page,
      page_size: Math.min(Math.max(opts.pageSize ?? 20, 1), 50),
    });
  }

  async getTrendSummary(orgId: number, days: number): Promise<TrendSummary> {
    // P0 从简：由三类列表端点聚合（上限 200/类）；后端 /rd/trends 结构核对后改为直读
    const kinds: TicketKind[] = ["requirement", "bug", "task"];
    const pages = await Promise.all(kinds.map((k) => this.listKind(orgId, k, { page: 1, page_size: 200 })));
    const since = Date.now() - days * 86400_000;
    const byKind = {
      requirement: { open: 0, closed: 0, total: 0 },
      bug: { open: 0, closed: 0, total: 0 },
      task: { open: 0, closed: 0, total: 0 },
    };
    let newlyCreated = 0;
    let newlyClosed = 0;
    for (const p of pages) {
      for (const t of p.items) {
        const bucket = byKind[t.kind];
        bucket.total += 1;
        if (t.status === "closed") bucket.closed += 1;
        else bucket.open += 1;
        if (Date.parse(t.createdAt) >= since) newlyCreated += 1;
        if (t.status === "closed" && Date.parse(t.updatedAt) >= since) newlyClosed += 1;
      }
    }
    return { orgId, days, byKind, newlyCreated, newlyClosed };
  }

  async updateTicketStatus(
    orgId: number,
    kind: TicketKind,
    id: number,
    toStatus: string,
    reason: string,
    options?: { idempotencyKey?: string },
  ): Promise<TicketRecord> {
    const current = await this.fetchDetail(orgId, kind, id);
    if (!current) throw new DomainError("NOT_FOUND", `未找到 ${kind} #${id}（组织 ${orgId}）`);
    assertTransition(kind, current.status, toStatus as TicketRecord["status"]);
    await this.call(`/rd/${KIND_PATH[kind]}/edit`, {
      method: "POST",
      headers: options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
      body: JSON.stringify({ id, status: toStatus, org_id: orgId, reason }),
    });
    const updated = await this.fetchDetail(orgId, kind, id);
    return updated ?? current;
  }
}

function mapRaw(kind: TicketKind, orgId: number, raw: Record<string, unknown>): TicketRecord {
  const num = (v: unknown): number => Number(v);
  const str = (v: unknown, fallback = ""): string => (v === undefined || v === null ? fallback : String(v));
  return {
    id: num(raw.id),
    kind,
    orgId,
    title: str(raw.title),
    description: str(raw.description),
    status: str(raw.status, "new") as TicketRecord["status"],
    priority: str(raw.priority, "medium"),
    assignee: str(raw.assignee),
    creator: str(raw.creator),
    createdAt: str(raw.create_time ?? raw.createdAt, ""),
    updatedAt: str(raw.update_time ?? raw.updatedAt, str(raw.create_time ?? raw.createdAt, "")),
  };
}
