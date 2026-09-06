/**
 * AI 配置资产的解析与配额判定（纯域逻辑，不碰 IO，便于单测）。
 *
 * 解析优先级（个人优先于组织）：
 *   1. explicit      —— 用户显式选中的那套（个人或已共享的组织配置）
 *   2. user_named    —— 个人配置中按名字指定
 *   3. user_default  —— 个人默认配置
 *   4. org_default   —— 组织默认配置（必须 shared 才对成员开放）
 *
 * 任一步命中且状态可用即返回；全落空则返回 412，由调用方提示用户先配置。
 * 显式选择不可用时返回 409；默认链跳过非 active 配置。
 * 实时用量由存储层检查，超限返回 429，不自动切换到另一套付费凭据。
 */
import type { AiProviderType, AiResponseType, AiServiceProvider } from "./aiConfig.js";

export type AiConfigScope = "user" | "org";
export type ConfigStatus = "active" | "disabled" | "quota_exceeded";
export type ResolveSource = "explicit" | "user_default" | "user_named" | "org_default";

/**
 * 配置的元数据视图：不含密钥。
 * 选择「用哪一套」只需要这些字段，因此可以只查元数据、只对命中的那一条解密，
 * 避免把用户所有密钥都解出来摊在内存里。
 */
export interface AiConfigMeta {
  id: number;
  scope: AiConfigScope;
  ownerId: number;
  name: string;
  providerType: AiProviderType;
  serviceProvider: AiServiceProvider;
  responseType: AiResponseType;
  endpointUrl: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  isDefault: boolean;
  shared: boolean;
  status: ConfigStatus;
}

/** 解密后的完整配置：apiKey 只在内存中短暂存在，绝不落日志 */
export interface AiConfigAsset extends AiConfigMeta {
  apiKey: string;
}

export interface ResolvedConfig {
  config: AiConfigMeta;
  source: ResolveSource;
  /** 命中组织配置时回填，供审计记录「这次用的是谁的钥匙」 */
  borrowedFromOrg: boolean;
}

export interface ResolveInput {
  userId: number;
  /** 用户显式选中的配置（来自 user_ai_preferences.active_config_id） */
  preferredConfigId?: number | null;
  /** 按名字选用个人配置 */
  requestedName?: string | null;
  /** 该用户的个人配置（status 可能含 disabled / quota_exceeded） */
  userConfigs: readonly AiConfigMeta[];
  /** 该用户所属组织的配置；调用方须保证已按组织归属过滤 */
  orgConfigs: readonly AiConfigMeta[];
}

export class AiConfigResolveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiConfigResolveError";
  }
}

function usable(config: AiConfigMeta): boolean {
  return config.status === "active";
}

function usableAndShared(config: AiConfigMeta): boolean {
  return usable(config) && config.shared;
}

export function resolveAiConfig(input: ResolveInput): ResolvedConfig {
  const { preferredConfigId, requestedName, userConfigs, orgConfigs } = input;

  if (preferredConfigId != null) {
    const personal = userConfigs.find((c) => c.id === preferredConfigId && usable(c));
    if (personal) {
      return { config: personal, source: "explicit", borrowedFromOrg: false };
    }
    // 允许显式借用组织配置，但必须是已共享且可用的
    const shared = orgConfigs.find((c) => c.id === preferredConfigId && usableAndShared(c));
    if (shared) {
      return { config: shared, source: "explicit", borrowedFromOrg: true };
    }
    throw new AiConfigResolveError(409, `选中的 AI 配置（id=${preferredConfigId}）不可用：不存在、已禁用或额度已用完`);
  }

  if (requestedName) {
    const named = userConfigs.find((c) => c.name === requestedName && usable(c));
    if (named) {
      return { config: named, source: "user_named", borrowedFromOrg: false };
    }
    throw new AiConfigResolveError(409, `个人配置中没有可用且名为「${requestedName}」的 AI 配置`);
  }

  const personalDefault = userConfigs.find((c) => c.isDefault && usable(c));
  if (personalDefault) {
    return { config: personalDefault, source: "user_default", borrowedFromOrg: false };
  }

  const orgDefault = orgConfigs.find((c) => c.isDefault && usableAndShared(c));
  if (orgDefault) {
    return { config: orgDefault, source: "org_default", borrowedFromOrg: true };
  }

  const hasAnyPersonal = userConfigs.some((c) => c.status !== "disabled");
  if (hasAnyPersonal) {
    throw new AiConfigResolveError(409, "个人 AI 配置当前不可用（额度已用完或被禁用），且组织没有可共享的配置");
  }
  throw new AiConfigResolveError(412, "尚未配置 AI 接口：请先在个人中心添加一套模型配置，或联系组织管理员共享配置");
}

// ---------------------------------------------------------------------------
// 用量与配额
// ---------------------------------------------------------------------------

export type QuotaPeriod = "daily" | "monthly";
export type QuotaMetric = "tokens" | "requests" | "cost_micros";

export interface QuotaRule {
  period: QuotaPeriod;
  metric: QuotaMetric;
  limitValue: number;
}

/** 一个统计窗口内的用量；金额单位统一为「微元」（百万分之一元） */
export interface UsageWindow {
  tokens: number;
  requests: number;
  costMicros: number;
}

export interface QuotaDecision {
  allowed: boolean;
  exceeded: QuotaRule[];
}

export const EMPTY_USAGE: UsageWindow = { tokens: 0, requests: 0, costMicros: 0 };

function usageValue(window: UsageWindow, metric: QuotaMetric): number {
  switch (metric) {
    case "tokens":
      return window.tokens;
    case "requests":
      return window.requests;
    case "cost_micros":
      return window.costMicros;
  }
}

/**
 * 判定是否仍在配额内。
 * 没有任何规则时视为不限量（allowed=true）——「未设限」与「已设限但未超」行为一致。
 */
export function evaluateQuotas(rules: readonly QuotaRule[], windows: { daily: UsageWindow; monthly: UsageWindow }): QuotaDecision {
  const exceeded = rules.filter((rule) => {
    const window = rule.period === "daily" ? windows.daily : windows.monthly;
    return usageValue(window, rule.metric) >= rule.limitValue;
  });
  return { allowed: exceeded.length === 0, exceeded };
}

/** 累加用量：只允许非负增量，防止上游脏数据把累计值改小 */
export function accumulateUsage(base: UsageWindow, delta: Partial<UsageWindow>): UsageWindow {
  const add = (current: number, incoming: number | undefined): number => {
    if (incoming == null) return current;
    if (!Number.isFinite(incoming) || incoming < 0) {
      throw new AiConfigResolveError(500, `用量增量必须是有限非负数，收到：${incoming}`);
    }
    return current + incoming;
  };
  return {
    tokens: add(base.tokens, delta.tokens),
    requests: add(base.requests, delta.requests),
    costMicros: add(base.costMicros, delta.costMicros),
  };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 天粒度桶（ai_usage_daily.usage_date）。统一用 UTC，避免跨时区账单错位 */
export function dailyBucket(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/** 月粒度起始日：月度配额统计的下界（含） */
export function monthStart(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-01`;
}
