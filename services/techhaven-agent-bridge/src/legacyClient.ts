import type { BridgeConfig } from "./config.js";
import type { LegacyBackendPort, TicketKind, TicketPage, TicketRecord, TrendSummary } from "./types.js";

const KIND_PATH: Record<TicketKind, string> = {
  requirement: "requirements",
  bug: "bugs",
  task: "tasks",
};

export class LegacyBackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    /** true 表示请求可能已到达旧后端，调用方不得盲目重试写操作。 */
    public readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "LegacyBackendError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class LegacyHttpClient implements LegacyBackendPort {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: BridgeConfig,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  private authHeaders(): Record<string, string> {
    if (this.config.legacyAuthMode === "bearer") {
      return { Authorization: `Bearer ${this.config.legacyAuthValue}` };
    }
    if (this.config.legacyAuthMode === "cookie") return { Cookie: this.config.legacyAuthValue };
    return {};
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.config.legacyTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.legacyBaseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: "application/json",
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...this.authHeaders(),
          ...init?.headers,
        },
      });
    } catch {
      if (timeoutSignal.aborted) {
        throw new LegacyBackendError("LEGACY_TIMEOUT", `旧后端请求超时：${path}`, 504, init?.method === "POST");
      }
      throw new LegacyBackendError("LEGACY_UNAVAILABLE", `旧后端不可用：${path}`, 502, init?.method === "POST");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LegacyBackendError("LEGACY_BAD_RESPONSE", `旧后端返回非 JSON：${path}`, 502, init?.method === "POST" && response.ok);
    }
    if (!response.ok) {
      throw new LegacyBackendError(
        "LEGACY_HTTP_ERROR",
        `旧后端 HTTP ${response.status}：${path}`,
        response.status >= 500 ? 502 : 400,
        init?.method === "POST" && response.status >= 500,
      );
    }

    const envelope = record(body);
    if (envelope && typeof envelope.errno === "number") {
      if (envelope.errno !== 0) {
        const message = String(envelope.msg ?? envelope.message ?? `旧后端错误码 ${envelope.errno}`);
        throw new LegacyBackendError("LEGACY_ERRNO", message, 400, false);
      }
      return envelope.data as T;
    }
    // 兼容部分旧接口直接返回 data，而不是 { errno, data }。
    return body as T;
  }

  private path(kind: TicketKind, suffix = ""): string {
    return `${this.config.legacyRdPrefix}/${KIND_PATH[kind]}${suffix}`;
  }

  private decodeStatus(kind: TicketKind, value: unknown): string {
    const raw = value === undefined || value === null ? "" : String(value);
    return this.config.statusMap[kind]?.[raw] ?? raw;
  }

  private encodeStatus(kind: TicketKind, canonical: string): string | number {
    const mapping = this.config.statusMap[kind] ?? {};
    const found = Object.entries(mapping).find(([, value]) => value === canonical)?.[0];
    if (found === undefined) return canonical;
    return /^-?\d+(?:\.\d+)?$/.test(found) ? Number(found) : found;
  }

  private mapTicket(kind: TicketKind, orgId: number, rawValue: unknown): TicketRecord {
    const raw = record(rawValue);
    if (!raw || !Number.isFinite(Number(raw.id))) {
      throw new LegacyBackendError("LEGACY_SCHEMA_MISMATCH", "旧后端工单响应缺少有效 id", 502, false);
    }
    const responseOrg = raw.org_id ?? raw.orgId ?? raw.organization_id;
    if (responseOrg !== undefined && (!Number.isInteger(Number(responseOrg)) || Number(responseOrg) !== orgId)) {
      throw new LegacyBackendError(
        "LEGACY_ORG_MISMATCH",
        `旧后端返回组织 ${String(responseOrg)}，与请求组织 ${orgId} 不一致`,
        502,
        false,
      );
    }
    const text = (value: unknown, fallback = ""): string => (value === undefined || value === null ? fallback : String(value));
    const createdAt = text(raw.create_time ?? raw.created_at ?? raw.createdAt);
    return {
      id: Number(raw.id),
      kind,
      orgId,
      title: text(raw.title),
      description: text(raw.description ?? raw.content),
      status: this.decodeStatus(kind, raw.status),
      priority: text(raw.priority, "medium"),
      assignee: text(raw.assignee ?? raw.assignee_name),
      creator: text(raw.creator ?? raw.creator_name),
      createdAt,
      updatedAt: text(raw.update_time ?? raw.updated_at ?? raw.updatedAt, createdAt),
    };
  }

  async getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    const value = await this.call<unknown>(`${this.path(kind, "/detail")}?id=${encodeURIComponent(String(id))}&org_id=${orgId}`);
    if (value === null || value === undefined) return null;
    return this.mapTicket(kind, orgId, value);
  }

  private async listKind(orgId: number, kind: TicketKind, params: Record<string, string | number | undefined>): Promise<TicketPage> {
    const query = new URLSearchParams({ org_id: String(orgId) });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const value = await this.call<unknown>(`${this.path(kind)}?${query.toString()}`);
    const wrapped = record(value);
    const rawItems = Array.isArray(value) ? value : Array.isArray(wrapped?.list) ? wrapped.list : [];
    const items = rawItems.map((item) => this.mapTicket(kind, orgId, item));
    return {
      total: Number(wrapped?.total ?? items.length),
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
      kinds.map((kind) =>
        this.listKind(orgId, kind, {
          status: opts.status === undefined ? undefined : this.encodeStatus(kind, opts.status),
          page: opts.page,
          page_size: pageSize,
        }),
      ),
    );
    const items = pages.flatMap((page) => page.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: pages.reduce((sum, page) => sum + page.total, 0),
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
    const pages = await Promise.all(
      (["requirement", "bug", "task"] as const).map((kind) => this.listKind(orgId, kind, { page: 1, page_size: 200 })),
    );
    const since = Date.now() - days * 86_400_000;
    const byKind: TrendSummary["byKind"] = {
      requirement: { open: 0, closed: 0, total: 0 },
      bug: { open: 0, closed: 0, total: 0 },
      task: { open: 0, closed: 0, total: 0 },
    };
    let newlyCreated = 0;
    let newlyClosed = 0;
    for (const page of pages) {
      for (const ticket of page.items) {
        const bucket = byKind[ticket.kind];
        bucket.total += 1;
        if (ticket.status === "closed") bucket.closed += 1;
        else bucket.open += 1;
        if (Date.parse(ticket.createdAt) >= since) newlyCreated += 1;
        if (ticket.status === "closed" && Date.parse(ticket.updatedAt) >= since) newlyClosed += 1;
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
    options?: { expectedFromStatus?: string },
  ): Promise<void> {
    // 期望的旧状态随写入下发：让支持条件更新的旧后端能在服务端做 compare-and-set，
    // 覆盖「读—校验—写」之间来自其他业务客户端的并发写入（审查意见 F5）。
    // 不支持的后端忽略该字段，语义退化为原来的无条件写，由写后对账兜底。
    const expected = options?.expectedFromStatus;
    await this.call(this.path(kind, "/edit"), {
      method: "POST",
      body: JSON.stringify({
        id,
        status: this.encodeStatus(kind, toStatus),
        org_id: orgId,
        reason,
        ...(expected === undefined ? {} : { expected_from_status: this.encodeStatus(kind, expected) }),
      }),
    });
  }
}
