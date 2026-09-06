export type LegacyAuthMode = "bearer" | "cookie" | "none";

export interface BridgeConfig {
  port: number;
  bridgeToken: string;
  legacyBaseUrl: string;
  legacyRdPrefix: string;
  legacyAuthMode: LegacyAuthMode;
  legacyAuthValue: string;
  legacyTimeoutMs: number;
  ledgerFile: string;
  statusMap: Record<string, Record<string, string>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim() ?? "";
  if (!value) throw new ConfigError(`缺少 ${key}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = (env[key] ?? String(fallback)).trim();
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} 必须是 ${min}~${max} 的整数，收到：${raw}`);
  }
  return value;
}

function parseStatusMap(raw: string | undefined): Record<string, Record<string, string>> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigError("TECHHAVEN_LEGACY_STATUS_MAP_JSON 不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("TECHHAVEN_LEGACY_STATUS_MAP_JSON 必须是对象");
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [kind, mapping] of Object.entries(value)) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new ConfigError(`TECHHAVEN_LEGACY_STATUS_MAP_JSON.${kind} 必须是对象`);
    }
    out[kind] = {};
    for (const [legacy, canonical] of Object.entries(mapping)) {
      if (typeof canonical !== "string" || !canonical.trim()) {
        throw new ConfigError(`TECHHAVEN_LEGACY_STATUS_MAP_JSON.${kind}.${legacy} 必须是非空字符串`);
      }
      if (Object.values(out[kind]).includes(canonical)) {
        throw new ConfigError(`TECHHAVEN_LEGACY_STATUS_MAP_JSON.${kind} 中 canonical 状态重复：${canonical}`);
      }
      out[kind][legacy] = canonical;
    }
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const bridgeToken = required(env, "TECHHAVEN_BRIDGE_TOKEN");
  if (Buffer.byteLength(bridgeToken, "utf8") < 32) {
    throw new ConfigError("TECHHAVEN_BRIDGE_TOKEN 必须至少 32 字节");
  }
  const legacyBaseUrl = required(env, "TECHHAVEN_LEGACY_BASE_URL").replace(/\/+$/, "");
  let parsedLegacyUrl: URL;
  try {
    parsedLegacyUrl = new URL(legacyBaseUrl);
  } catch {
    throw new ConfigError("TECHHAVEN_LEGACY_BASE_URL 必须是合法 URL");
  }
  if (!(["http:", "https:"] as const).includes(parsedLegacyUrl.protocol as "http:" | "https:")) {
    throw new ConfigError("TECHHAVEN_LEGACY_BASE_URL 只允许 http 或 https");
  }
  if (parsedLegacyUrl.username || parsedLegacyUrl.password || parsedLegacyUrl.search || parsedLegacyUrl.hash) {
    throw new ConfigError("TECHHAVEN_LEGACY_BASE_URL 不得包含用户信息、查询串或片段");
  }
  const legacyAuthMode = (env.TECHHAVEN_LEGACY_AUTH_MODE ?? "bearer").trim().toLowerCase();
  if (legacyAuthMode !== "bearer" && legacyAuthMode !== "cookie" && legacyAuthMode !== "none") {
    throw new ConfigError(`TECHHAVEN_LEGACY_AUTH_MODE 只能是 bearer | cookie | none，收到：${legacyAuthMode}`);
  }
  const legacyAuthValue = env.TECHHAVEN_LEGACY_AUTH_VALUE?.trim() ?? "";
  if (legacyAuthMode !== "none" && !legacyAuthValue) {
    throw new ConfigError(`TECHHAVEN_LEGACY_AUTH_MODE=${legacyAuthMode} 时必须设置 TECHHAVEN_LEGACY_AUTH_VALUE`);
  }
  const legacyRdPrefix = (env.TECHHAVEN_LEGACY_RD_PREFIX ?? "/rd").trim();
  if (!legacyRdPrefix.startsWith("/") || legacyRdPrefix.includes("?")) {
    throw new ConfigError("TECHHAVEN_LEGACY_RD_PREFIX 必须是以 / 开头且不含查询串的路径");
  }
  return {
    port: integer(env, "TECHHAVEN_BRIDGE_PORT", 3093, 1, 65_535),
    bridgeToken,
    legacyBaseUrl,
    legacyRdPrefix: legacyRdPrefix.replace(/\/+$/, ""),
    legacyAuthMode,
    legacyAuthValue,
    legacyTimeoutMs: integer(env, "TECHHAVEN_LEGACY_TIMEOUT_MS", 5_000, 100, 60_000),
    ledgerFile: env.TECHHAVEN_BRIDGE_LEDGER_FILE?.trim() || "./data/bridge-operations.jsonl",
    statusMap: parseStatusMap(env.TECHHAVEN_LEGACY_STATUS_MAP_JSON),
  };
}
