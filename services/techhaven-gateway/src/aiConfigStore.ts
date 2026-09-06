import pg from "pg";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_IDS,
  normalizeProviderBaseUrl,
  positiveUserId,
  PROVIDER_ENV,
  type AiConfigResolver,
  type AiProviderType,
  type AiResponseType,
  type AiServiceProvider,
} from "./aiConfig.js";
import { decryptSecret, encryptSecret, maskSecret, secretFingerprint, type MasterKeySet } from "./aiConfigCrypto.js";
import type {
  AiConfigAsset,
  AiConfigMeta,
  AiConfigScope,
  ConfigStatus,
  QuotaRule,
  ResolvedConfig,
  ResolveSource,
  UsageWindow,
} from "./aiConfigAssets.js";
import { AiConfigResolveError, dailyBucket, evaluateQuotas, monthStart, resolveAiConfig } from "./aiConfigAssets.js";
import type { EngineRuntimeConfig } from "./types.js";

const META_COLUMNS = `id, scope, owner_id, name, provider_type, service_provider, response_type,
  endpoint_url, api_key_masked, model, reasoning_effort, max_tokens,
  is_default, shared, status, last_used_at`;

export interface MetaRow {
  id: string;
  scope: AiConfigScope;
  owner_id: string;
  name: string;
  provider_type: AiProviderType;
  service_provider: AiServiceProvider;
  response_type: AiResponseType;
  endpoint_url: string;
  api_key_masked: string;
  model: string | null;
  reasoning_effort: string | null;
  max_tokens: number | null;
  is_default: boolean;
  shared: boolean;
  status: ConfigStatus;
  last_used_at: Date | null;
}

export class AiConfigStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiConfigStoreError";
  }
}

/** 列表视图：含脱敏密钥，永远不带明文 */
export interface AiConfigSummary extends AiConfigMeta {
  apiKeyMasked: string;
  lastUsedAt?: string;
}

export interface CreateConfigInput {
  scope: AiConfigScope;
  ownerId: number;
  name: string;
  providerType: AiProviderType;
  serviceProvider: AiServiceProvider;
  responseType: AiResponseType;
  endpointUrl: string;
  apiKey: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  isDefault?: boolean;
  shared?: boolean;
  createdBy: number;
}

/** 可更新的非密钥字段；undefined 表示不改动 */
export interface UpdateConfigInput {
  apiKey?: string;
  name?: string;
  endpointUrl?: string;
  providerType?: AiProviderType;
  serviceProvider?: AiServiceProvider;
  responseType?: AiResponseType;
  model?: string | null;
  reasoningEffort?: string | null;
  maxTokens?: number | null;
  isDefault?: boolean;
  shared?: boolean;
  status?: ConfigStatus;
}

export interface UsageDelta {
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costMicros?: number;
  sessions?: number;
}

export interface ResolveForRunInput {
  userId: number;
  orgId?: number | null;
  requestedName?: string | null;
}

export interface ResolvedForRun {
  config: AiConfigAsset;
  source: ResolveSource;
  borrowedFromOrg: boolean;
}

function toMeta(row: MetaRow): AiConfigMeta {
  return {
    id: Number(row.id),
    scope: row.scope,
    ownerId: Number(row.owner_id),
    name: row.name,
    providerType: row.provider_type,
    serviceProvider: row.service_provider,
    responseType: row.response_type,
    endpointUrl: row.endpoint_url,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    maxTokens: row.max_tokens ?? undefined,
    isDefault: row.is_default,
    shared: row.shared,
    status: row.status,
  };
}

function toSummary(row: MetaRow): AiConfigSummary {
  const summary: AiConfigSummary = { ...toMeta(row), apiKeyMasked: row.api_key_masked };
  if (row.last_used_at) summary.lastUsedAt = new Date(row.last_used_at).toISOString();
  return summary;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * AI 配置资产的 PostgreSQL 存储。
 *
 * 约定：
 * - 明文密钥只在 create / rotateKey / resolveForRun 的内存里出现，查询一律不含密文列；
 * - 配额在 resolve 时按实时用量判定，不依赖 ai_configs.status 的持久化状态，
 *   避免「跨日重置后状态没改回来」这类不一致；
 * - 所有金额以微元（cost_micros）整数累加。
 */
export class AiConfigStore {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly keys: MasterKeySet,
  ) {}

  static async connect(dbUrl: string, keys: MasterKeySet, schema = "public"): Promise<AiConfigStore> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error(`PostgreSQL schema 非法：${schema}`);
    const pool = new pg.Pool({
      connectionString: dbUrl,
      max: 8,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("SELECT 1");
      // Do not announce asset mode against a database missing its migrations.
      await pool.query("SELECT config_id, event_key FROM ai_usage_receipts LIMIT 0");
      await pool.query("SELECT org_id, user_id FROM ai_org_memberships LIMIT 0");
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw new AiConfigStoreError(503, `连接 Agent DB 失败：${(err as Error).message}`);
    }
    return new AiConfigStore(pool, keys);
  }

  /** 仅供单元测试注入 fake pool；生产代码请走 connect() */
  static forTesting(pool: pg.Pool, keys: MasterKeySet): AiConfigStore {
    return new AiConfigStore(pool, keys);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 列出某归属下的全部配置（含禁用；管理界面需要看全貌） */
  async listByOwner(scope: AiConfigScope, ownerId: number): Promise<AiConfigSummary[]> {
    const { rows } = await this.pool.query<MetaRow>(
      `SELECT ${META_COLUMNS} FROM ai_configs WHERE scope = $1 AND owner_id = $2 ORDER BY is_default DESC, name`,
      [scope, ownerId],
    );
    return rows.map(toSummary);
  }

  async create(input: CreateConfigInput): Promise<AiConfigSummary> {
    const cipher = encryptSecret(input.apiKey, this.keys);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.isDefault) {
        await client.query(
          `UPDATE ai_configs SET is_default = false, updated_at = now()
            WHERE scope = $1 AND owner_id = $2 AND is_default`,
          [input.scope, input.ownerId],
        );
      }
      const { rows } = await client.query<MetaRow>(
        `INSERT INTO ai_configs (
           scope, owner_id, name, provider_type, service_provider, response_type, endpoint_url,
           api_key_cipher, api_key_fp, api_key_masked, key_version,
           model, reasoning_effort, max_tokens, is_default, shared, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${META_COLUMNS}`,
        [
          input.scope,
          input.ownerId,
          input.name,
          input.providerType,
          input.serviceProvider,
          input.responseType,
          input.endpointUrl,
          cipher,
          secretFingerprint(input.apiKey),
          maskSecret(input.apiKey),
          this.keys.currentVersion,
          input.model ?? null,
          input.reasoningEffort ?? null,
          input.maxTokens ?? null,
          input.isDefault ?? false,
          input.shared ?? false,
          input.createdBy,
        ],
      );
      await client.query("COMMIT");
      return toSummary(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(err)) {
        throw new AiConfigStoreError(409, `已存在同名的 AI 配置「${input.name}」`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** 更新非密钥字段；置为默认时会先清掉同归属下的旧默认 */
  async update(id: number, scope: AiConfigScope, ownerId: number, patch: UpdateConfigInput): Promise<AiConfigSummary> {
    const cipher = patch.apiKey === undefined ? null : encryptSecret(patch.apiKey, this.keys);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (patch.isDefault) {
        await client.query(
          `UPDATE ai_configs SET is_default = false, updated_at = now()
            WHERE scope = $1 AND owner_id = $2 AND is_default AND id <> $3`,
          [scope, ownerId, id],
        );
      }
      const { rows } = await client.query<MetaRow>(
        `UPDATE ai_configs SET
           name             = COALESCE($4, name),
           endpoint_url     = COALESCE($5, endpoint_url),
           provider_type    = COALESCE($6, provider_type),
           service_provider = COALESCE($7, service_provider),
           response_type    = COALESCE($8, response_type),
           model            = CASE WHEN $9::boolean THEN $10 ELSE model END,
           reasoning_effort = CASE WHEN $11::boolean THEN $12 ELSE reasoning_effort END,
           max_tokens       = CASE WHEN $13::boolean THEN $14 ELSE max_tokens END,
           is_default       = COALESCE($15, is_default),
           shared           = COALESCE($16, shared),
           status           = COALESCE($17, status),
           api_key_cipher   = COALESCE($18::bytea, api_key_cipher),
           api_key_fp       = COALESCE($19, api_key_fp),
           api_key_masked   = COALESCE($20, api_key_masked),
           key_version      = COALESCE($21, key_version),
           updated_at       = now()
         WHERE id = $1 AND scope = $2 AND owner_id = $3
         RETURNING ${META_COLUMNS}`,
        [
          id,
          scope,
          ownerId,
          patch.name ?? null,
          patch.endpointUrl ?? null,
          patch.providerType ?? null,
          patch.serviceProvider ?? null,
          patch.responseType ?? null,
          patch.model !== undefined,
          patch.model ?? null,
          patch.reasoningEffort !== undefined,
          patch.reasoningEffort ?? null,
          patch.maxTokens !== undefined,
          patch.maxTokens ?? null,
          patch.isDefault ?? null,
          patch.shared ?? null,
          patch.status ?? null,
          cipher,
          patch.apiKey === undefined ? null : secretFingerprint(patch.apiKey),
          patch.apiKey === undefined ? null : maskSecret(patch.apiKey),
          patch.apiKey === undefined ? null : this.keys.currentVersion,
        ],
      );
      if (rows.length === 0) {
        throw new AiConfigStoreError(404, `未找到归属下的 AI 配置（id=${id}）`);
      }
      await client.query("COMMIT");
      return toSummary(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (err instanceof AiConfigStoreError) throw err;
      if (isUniqueViolation(err)) {
        throw new AiConfigStoreError(409, `已存在同名的 AI 配置「${patch.name ?? ""}」`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** 更换密钥：重算密文、指纹与脱敏串 */
  async rotateKey(id: number, scope: AiConfigScope, ownerId: number, apiKey: string): Promise<AiConfigSummary> {
    const cipher = encryptSecret(apiKey, this.keys);
    const { rows } = await this.pool.query<MetaRow>(
      `UPDATE ai_configs SET
         api_key_cipher = $4, api_key_fp = $5, api_key_masked = $6,
         key_version = $7, status = 'active', updated_at = now()
       WHERE id = $1 AND scope = $2 AND owner_id = $3
       RETURNING ${META_COLUMNS}`,
      [id, scope, ownerId, cipher, secretFingerprint(apiKey), maskSecret(apiKey), this.keys.currentVersion],
    );
    if (rows.length === 0) {
      throw new AiConfigStoreError(404, `未找到归属下的 AI 配置（id=${id}）`);
    }
    return toSummary(rows[0]);
  }

  async remove(id: number, scope: AiConfigScope, ownerId: number): Promise<void> {
    const { rowCount } = await this.pool.query(`DELETE FROM ai_configs WHERE id = $1 AND scope = $2 AND owner_id = $3`, [
      id,
      scope,
      ownerId,
    ]);
    if (rowCount === 0) {
      throw new AiConfigStoreError(404, `未找到归属下的 AI 配置（id=${id}）`);
    }
  }

  async getPreference(userId: number): Promise<{ orgId?: number; activeConfigId?: number }> {
    const { rows } = await this.pool.query<{ org_id: string | null; active_config_id: string | null }>(
      `SELECT org_id, active_config_id FROM user_ai_preferences WHERE user_id = $1`,
      [userId],
    );
    if (rows.length === 0) return {};
    const result: { orgId?: number; activeConfigId?: number } = {};
    if (rows[0].org_id != null) {
      result.orgId = Number(rows[0].org_id);
      await this.requireOrgMember(userId, result.orgId);
    }
    if (rows[0].active_config_id != null) result.activeConfigId = Number(rows[0].active_config_id);
    return result;
  }

  /** configId 传 null 表示清空选择，回到默认解析链 */
  async setPreference(userId: number, orgId: number | null, configId: number | null): Promise<void> {
    if (orgId !== null) await this.requireOrgMember(userId, orgId);
    if (configId !== null) {
      const { rows } = await this.pool.query(
        `SELECT id FROM ai_configs WHERE id = $1 AND
          ((scope = 'user' AND owner_id = $2) OR (scope = 'org' AND owner_id = $3 AND shared = true))`,
        [configId, userId, orgId],
      );
      if (!rows.length) throw new AiConfigStoreError(404, "配置不存在或无权使用");
    }
    await this.pool.query(
      `INSERT INTO user_ai_preferences (user_id, org_id, active_config_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         active_config_id = EXCLUDED.active_config_id,
         updated_at = now()`,
      [userId, orgId, configId],
    );
  }

  async listQuotas(configId: number): Promise<QuotaRule[]> {
    const { rows } = await this.pool.query<{ period: QuotaRule["period"]; metric: QuotaRule["metric"]; limit_value: string }>(
      `SELECT period, metric, limit_value FROM ai_quotas WHERE config_id = $1`,
      [configId],
    );
    return rows.map((r) => ({ period: r.period, metric: r.metric, limitValue: Number(r.limit_value) }));
  }

  /** Membership grants are managed by the trusted administration/sync channel only. */
  async requireOrgMember(userId: number, orgId: number): Promise<void> {
    const { rows } = await this.pool.query(`SELECT 1 FROM ai_org_memberships WHERE user_id = $1 AND org_id = $2`, [userId, orgId]);
    if (!rows.length) throw new AiConfigStoreError(403, "无权使用该组织的 AI 配置");
  }

  async replaceQuotas(configId: number, rules: readonly QuotaRule[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ai_quotas WHERE config_id = $1`, [configId]);
      for (const rule of rules) {
        await client.query(`INSERT INTO ai_quotas (config_id, period, metric, limit_value) VALUES ($1,$2,$3,$4)`, [
          configId,
          rule.period,
          rule.metric,
          rule.limitValue,
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async usageWindows(configId: number, now: Date = new Date()): Promise<{ daily: UsageWindow; monthly: UsageWindow }> {
    const empty: UsageWindow = { tokens: 0, requests: 0, costMicros: 0 };
    const { rows } = await this.pool.query<{
      total_tokens: string | null;
      request_count: string | null;
      cost_micros: string | null;
    }>(
      `SELECT
         SUM(total_tokens)  AS total_tokens,
         SUM(request_count) AS request_count,
         SUM(cost_micros)   AS cost_micros
       FROM ai_usage_daily
       WHERE config_id = $1 AND usage_date >= $2`,
      [configId, monthStart(now)],
    );
    const { rows: todayRows } = await this.pool.query<{
      total_tokens: string | null;
      request_count: string | null;
      cost_micros: string | null;
    }>(
      `SELECT total_tokens, request_count, cost_micros FROM ai_usage_daily
       WHERE config_id = $1 AND usage_date = $2`,
      [configId, dailyBucket(now)],
    );

    const monthly: UsageWindow = {
      tokens: Number(rows[0]?.total_tokens ?? 0),
      requests: Number(rows[0]?.request_count ?? 0),
      costMicros: Number(rows[0]?.cost_micros ?? 0),
    };
    const today = todayRows[0];
    const daily: UsageWindow = today
      ? {
          tokens: Number(today.total_tokens ?? 0),
          requests: Number(today.request_count ?? 0),
          costMicros: Number(today.cost_micros ?? 0),
        }
      : empty;
    return { daily, monthly };
  }

  /**
   * 解析一次运行要用的配置：选出 → 解密 → 校验配额。
   * 只对命中的那一条解密，其余配置全程以元数据形式参与选择。
   */
  async resolveForRun(input: ResolveForRunInput): Promise<ResolvedForRun> {
    const preference = await this.getPreference(input.userId);
    const orgId = input.orgId ?? preference.orgId ?? null;
    if (orgId !== null) await this.requireOrgMember(input.userId, orgId);

    const { rows: userRows } = await this.pool.query<MetaRow>(
      `SELECT ${META_COLUMNS} FROM ai_configs WHERE scope = 'user' AND owner_id = $1 ORDER BY is_default DESC, name`,
      [input.userId],
    );
    // SQL 层先滤掉未共享的组织配置，纯函数再校验一次，双保险
    const orgRows = orgId
      ? (
          await this.pool.query<MetaRow>(
            `SELECT ${META_COLUMNS} FROM ai_configs
              WHERE scope = 'org' AND owner_id = $1 AND shared = true
              ORDER BY is_default DESC, name`,
            [orgId],
          )
        ).rows
      : [];

    let picked: ResolvedConfig;
    try {
      picked = resolveAiConfig({
        userId: input.userId,
        preferredConfigId: preference.activeConfigId ?? null,
        requestedName: input.requestedName ?? null,
        userConfigs: userRows.map(toMeta),
        orgConfigs: orgRows.map(toMeta),
      });
    } catch (err) {
      if (err instanceof AiConfigResolveError) {
        throw new AiConfigStoreError(err.status, err.message);
      }
      throw err;
    }

    const windows = await this.usageWindows(picked.config.id);
    const rules = await this.listQuotas(picked.config.id);
    if (rules.some((rule) => rule.metric === "cost_micros")) {
      throw new AiConfigStoreError(412, "当前引擎没有可信的计费价格数据，请使用请求数或 token 配额");
    }
    const decision = evaluateQuotas(rules, windows);
    if (!decision.allowed) {
      const detail = decision.exceeded.map((r) => `${r.period}/${r.metric}`).join("、");
      throw new AiConfigStoreError(429, `AI 配置「${picked.config.name}」已超出配额（${detail}）`);
    }

    const { rows: secretRows } = await this.pool.query<{ api_key_cipher: Buffer }>(
      `SELECT api_key_cipher FROM ai_configs WHERE id = $1`,
      [picked.config.id],
    );
    if (secretRows.length === 0) {
      throw new AiConfigStoreError(404, `AI 配置已被删除（id=${picked.config.id}）`);
    }

    return {
      config: { ...picked.config, apiKey: decryptSecret(secretRows[0].api_key_cipher, this.keys) },
      source: picked.source,
      borrowedFromOrg: picked.borrowedFromOrg,
    };
  }

  /** 会话结束后回写用量：日聚合 upsert + 使用明细 + 最近使用时间 */
  async recordUsage(params: {
    configId: number;
    userId: number;
    scopeSnapshot: AiConfigScope;
    resolvedFrom: ResolveSource;
    sessionSid?: string;
    eventKey?: string;
    delta: UsageDelta;
    now?: Date;
  }): Promise<void> {
    const { delta, now = new Date() } = params;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (params.sessionSid) {
        const receipt = await client.query(
          `INSERT INTO ai_usage_receipts (config_id, session_sid, event_key)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [params.configId, params.sessionSid, params.eventKey ?? "final"],
        );
        if (receipt.rowCount === 0) {
          await client.query("COMMIT");
          return;
        }
      }
      await client.query(
        `INSERT INTO ai_usage_daily
           (config_id, usage_date, session_count, request_count, prompt_tokens, completion_tokens, total_tokens, cost_micros)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (config_id, usage_date) DO UPDATE SET
           session_count     = ai_usage_daily.session_count     + EXCLUDED.session_count,
           request_count     = ai_usage_daily.request_count     + EXCLUDED.request_count,
           prompt_tokens     = ai_usage_daily.prompt_tokens     + EXCLUDED.prompt_tokens,
           completion_tokens = ai_usage_daily.completion_tokens + EXCLUDED.completion_tokens,
           total_tokens      = ai_usage_daily.total_tokens      + EXCLUDED.total_tokens,
           cost_micros       = ai_usage_daily.cost_micros       + EXCLUDED.cost_micros,
           updated_at        = now()`,
        [
          params.configId,
          dailyBucket(now),
          delta.sessions ?? 0,
          delta.requests ?? 0,
          delta.promptTokens ?? 0,
          delta.completionTokens ?? 0,
          delta.totalTokens ?? 0,
          delta.costMicros ?? 0,
        ],
      );
      await client.query(
        `INSERT INTO ai_config_usages
           (config_id, scope_snapshot, resolved_from, user_id, session_sid, request_count, total_tokens, cost_micros)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          params.configId,
          params.scopeSnapshot,
          params.resolvedFrom,
          params.userId,
          params.sessionSid ?? null,
          delta.requests ?? 0,
          delta.totalTokens ?? 0,
          delta.costMicros ?? 0,
        ],
      );
      await client.query(`UPDATE ai_configs SET last_used_at = now() WHERE id = $1`, [params.configId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 读取某配置的累计用量（账单与展示） */
  async usageTotal(configId: number): Promise<UsageWindow & { sessions: number }> {
    const { rows } = await this.pool.query<{
      total_tokens: string | null;
      request_count: string | null;
      cost_micros: string | null;
      session_count: string | null;
    }>(
      `SELECT
         SUM(total_tokens)  AS total_tokens,
         SUM(request_count) AS request_count,
         SUM(cost_micros)   AS cost_micros,
         SUM(session_count) AS session_count
       FROM ai_usage_daily WHERE config_id = $1`,
      [configId],
    );
    return {
      tokens: Number(rows[0]?.total_tokens ?? 0),
      requests: Number(rows[0]?.request_count ?? 0),
      costMicros: Number(rows[0]?.cost_micros ?? 0),
      sessions: Number(rows[0]?.session_count ?? 0),
    };
  }
}

/**
 * 存储版 resolver：替代 HttpAiConfigResolver。
 * 会话创建时按 actor 从 Agent DB 解出该用户的配置资产，
 * 转成 dsh 子进程需要的 EngineRuntimeConfig（密钥只进入子进程环境变量）。
 */
export class StoreAiConfigResolver implements AiConfigResolver {
  private readonly providerIds: Record<AiProviderType, string>;

  constructor(
    private readonly store: AiConfigStore,
    providerIds: Partial<Record<AiProviderType, string>> = {},
  ) {
    this.providerIds = { ...DEFAULT_PROVIDER_IDS, ...providerIds };
  }

  /**
   * orgId 必须是**已通过成员校验**的那个组织（见 orgAccess.ts）。
   * 传给 resolveForRun 后，store 会再次 requireOrgMember：配置解析与会话创建
   * 共用同一份授权判定，避免「会话属于组织 A、配置取自组织 B」的错配。
   */
  async resolve(actor: string, orgId?: number): Promise<EngineRuntimeConfig> {
    const userId = Number(positiveUserId(actor));
    const resolved = await this.store.resolveForRun({ userId, orgId });
    return {
      ...assetToRuntimeConfig(resolved.config, this.providerIds),
      recordUsage: (sessionSid, eventKey, delta) =>
        this.store.recordUsage({
          configId: resolved.config.id,
          userId,
          scopeSnapshot: resolved.config.scope,
          resolvedFrom: resolved.source,
          sessionSid,
          eventKey,
          delta,
        }),
    };
  }
}

/** 配置资产 → dsh 运行时配置；URL 规则与 Claude max_tokens 约束和 HTTP 版保持一致 */
export function assetToRuntimeConfig(
  asset: AiConfigAsset,
  providerIds: Record<AiProviderType, string> = DEFAULT_PROVIDER_IDS,
): EngineRuntimeConfig {
  const model = asset.model?.trim() || DEFAULT_MODELS[asset.providerType];
  if (asset.providerType === "claude" && asset.maxTokens == null) {
    throw new AiConfigStoreError(412, "Claude 配置必须填写 max_tokens，请补全后重试");
  }
  const envNames = PROVIDER_ENV[asset.providerType];
  return {
    provider: providerIds[asset.providerType],
    model,
    ...(asset.reasoningEffort === undefined ? {} : { reasoningEffort: asset.reasoningEffort }),
    maxTokens: asset.maxTokens,
    env: {
      [envNames.key]: asset.apiKey,
      [envNames.baseUrl]: normalizeProviderBaseUrl(asset.endpointUrl, asset.providerType, asset.responseType),
    },
  };
}
