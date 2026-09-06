export interface BffConfig {
  /** 监听地址（默认 127.0.0.1，只服务同机 Nginx auth_request） */
  host: string;
  /** 监听端口（默认 3092） */
  port: number;
  /** 产品后端 base，如 https://techhaven.website:8080 */
  apiBase: string;
  /** 后端验证调用超时（毫秒） */
  verifyTimeoutMs: number;
  /** 验证成功结果缓存 TTL（毫秒；0 = 不缓存） */
  cacheTtlMs: number;
  /** 缓存容量上限 */
  cacheMaxEntries: number;
}

export class BffConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BffConfigError";
  }
}

function positiveInt(raw: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new BffConfigError(`${name} 必须是 0~${max} 的整数，收到：${trimmed}`);
  }
  return parsed;
}

export function loadBffConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const host = env.TECHHAVEN_BFF_HOST?.trim() || "127.0.0.1";
  const portRaw = positiveInt(env.TECHHAVEN_BFF_PORT, 3092, "TECHHAVEN_BFF_PORT", 65535);
  if (portRaw === 0) throw new BffConfigError("TECHHAVEN_BFF_PORT 不能为 0");

  const apiBaseRaw = env.TECHHAVEN_API_BASE?.trim() ?? "";
  if (!apiBaseRaw) {
    throw new BffConfigError("缺少 TECHHAVEN_API_BASE（产品后端 base，用于验证会话）");
  }
  let apiBase: string;
  try {
    const parsed = new URL(apiBaseRaw);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new BffConfigError("TECHHAVEN_API_BASE 必须是 HTTPS（本机回环除外）");
    }
    apiBase = parsed.origin;
  } catch (err) {
    if (err instanceof BffConfigError) throw err;
    throw new BffConfigError(`TECHHAVEN_API_BASE 不是合法 URL：${apiBaseRaw}`);
  }

  return {
    host,
    port: portRaw,
    apiBase,
    verifyTimeoutMs: positiveInt(env.TECHHAVEN_BFF_VERIFY_TIMEOUT_MS, 3000, "TECHHAVEN_BFF_VERIFY_TIMEOUT_MS", 60_000),
    cacheTtlMs: positiveInt(env.TECHHAVEN_BFF_CACHE_TTL_MS, 60_000, "TECHHAVEN_BFF_CACHE_TTL_MS"),
    cacheMaxEntries: positiveInt(env.TECHHAVEN_BFF_CACHE_MAX_ENTRIES, 5000, "TECHHAVEN_BFF_CACHE_MAX_ENTRIES", 1_000_000),
  };
}
