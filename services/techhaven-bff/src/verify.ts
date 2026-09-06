import type { BffConfig } from "./config.js";

/**
 * 会话验证器：把浏览器 token 换成可信 userId。
 *
 * 产品后端响应包装为 { errno, msg, data }：errno=0 表示已登录（未登录返回 errno=1101）；
 * data 中的用户 id 字段名取 uid / user_id / id 兼容——确切字段以后端联调为准，
 * 三者都没有时按失败关闭（视为未登录），宁可拒绝也不放行不明身份。
 *
 * 防爆破与保护后端：
 * - 成功结果短 TTL 缓存（TTL 内容器内的请求不再打扰后端）；
 * - 同一 token 的并发请求合并为一次后端调用（inflight 去重）；
 * - 失败不缓存：后端短暂故障不会把已登录用户长期锁在外面。
 */

interface CacheEntry {
  userId: number;
  expiresAt: number;
}

export interface SessionVerifierOptions {
  apiBase: string;
  timeoutMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class SessionVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<number | null>>();

  constructor(private readonly options: SessionVerifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  static fromConfig(config: BffConfig, fetchImpl?: typeof fetch): SessionVerifier {
    return new SessionVerifier({
      apiBase: config.apiBase,
      timeoutMs: config.verifyTimeoutMs,
      cacheTtlMs: config.cacheTtlMs,
      cacheMaxEntries: config.cacheMaxEntries,
      fetchImpl,
    });
  }

  async verifyToken(token: string): Promise<number | null> {
    const cached = this.readCache(token);
    if (cached !== null) return cached;

    const running = this.inflight.get(token);
    if (running) return running;

    const attempt = this.callBackend(token)
      .then((userId) => {
        if (userId !== null) this.writeCache(token, userId);
        return userId;
      })
      .finally(() => {
        this.inflight.delete(token);
      });
    this.inflight.set(token, attempt);
    return attempt;
  }

  private readCache(token: string): number | null {
    if (this.options.cacheTtlMs <= 0) return null;
    const entry = this.cache.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(token);
      return null;
    }
    return entry.userId;
  }

  private writeCache(token: string, userId: number): void {
    if (this.options.cacheTtlMs <= 0) return;
    // 容量兜底：先进先出淘汰（Map 迭代顺序即插入顺序）
    while (this.cache.size >= this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(token, { userId, expiresAt: this.now() + this.options.cacheTtlMs });
  }

  private async callBackend(token: string): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiBase}/api/v1/user/info`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      // 超时或网络异常：失败关闭，但绝不缓存失败（见类注释）
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) return null;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    return extractUserId(payload);
  }
}

/** 从后端包装响应中提取用户 id；errno 非 0 或字段缺失/非法都视为未登录 */
export function extractUserId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const envelope = payload as Record<string, unknown>;
  if (envelope.errno !== 0) return null;
  const data = envelope.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const candidate = record.uid ?? record.user_id ?? record.id;
  const userId = typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : candidate;
  if (!Number.isInteger(userId) || (userId as number) < 1) return null;
  return userId as number;
}

/** 从请求头提取候选 token：优先 Authorization Bearer，其次 S_TOKEN Cookie */
export function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  const authRaw = headers["authorization"];
  const auth = Array.isArray(authRaw) ? authRaw[0] : authRaw;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1]) return match[1].trim();
  }
  const cookieRaw = headers["cookie"];
  const cookie = Array.isArray(cookieRaw) ? cookieRaw.join("; ") : cookieRaw;
  if (typeof cookie === "string") {
    const match = /(?:^|;\s*)S_TOKEN=([^;]+)/.exec(cookie);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}
