/** 引擎驱动类型：mock=脚本化闭环；dsh=真实引擎（drivers/dsh.ts 经官方 SDK 驱动） */
export type EngineDriverKind = "mock" | "dsh";
export type GatewayStoreKind = "jsonl" | "postgres";

export interface Config {
  /** Bearer 令牌：除 /healthz 外所有 API 的鉴权凭据（TECHHAVEN_GATEWAY_TOKEN，必填） */
  gatewayToken: string;
  /** HTTP 监听端口（TECHHAVEN_GATEWAY_PORT，默认 3091） */
  port: number;
  /**
   * HTTP 监听地址（TECHHAVEN_GATEWAY_HOST，默认 127.0.0.1）。
   * 默认只监听回环：3091 承载 Bearer 鉴权的 Agent API，只能由同机 Nginx/BFF 访问。
   */
  host: string;
  /** 引擎驱动（TECHHAVEN_ENGINE_DRIVER，默认 mock） */
  driver: EngineDriverKind;
  /** 会话事件 / 审计 JSONL 目录（TECHHAVEN_GATEWAY_DATA_DIR，默认 ./data） */
  dataDir: string;
  /** 权威存储：jsonl=单实例 PoC；postgres=PG 权威且 JSONL 仅作 spool */
  store: GatewayStoreKind;
  /** TECHHAVEN_GATEWAY_DB_URL；store=postgres 时必填 */
  dbUrl: string;
  /** PostgreSQL schema（默认 public；测试可用隔离 schema） */
  dbSchema: string;
  /** JSONL proposal 共享文件；store=jsonl 时与 techhaven-mcp ProposalStore 共用 */
  proposalsFile: string;
  /** 单组织活动会话数配额（TECHHAVEN_MAX_SESSIONS_PER_ORG，默认 3，正整数） */
  maxSessionsPerOrg: number;
  /** 终态会话驻留分钟数：到点从注册表淘汰（TECHHAVEN_SESSION_RETENTION_MINUTES，默认 30；0 = 不淘汰） */
  sessionRetentionMinutes: number;
  /** 会话空闲超时分钟数：超时合成 failed 终态（TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES，默认 30；0 = 关闭） */
  sessionIdleTimeoutMinutes: number;
  /** dsh 可执行文件路径（drivers/dsh.ts 经驱动构造器消费；TECHHAVEN_DSH_BIN） */
  dshBin?: string;
  /** dsh 引擎 profile 名：由 Gateway 经 DshSdkDriver 构造器统一下发，前端不可指定（TECHHAVEN_DSH_PROFILE） */
  dshProfile?: string;
  /** dsh 引擎主目录 / 工作区根（drivers/dsh.ts 经驱动构造器消费；TECHHAVEN_DSH_HOME） */
  dshHome?: string;
  /** 产品后端提供的内部用户 AI 配置读取端点；未设置时沿用 Gateway 进程级模型凭据 */
  aiConfigUrl?: string;
  /** Gateway → 产品后端内部端点的独立服务令牌，不得与 Gateway token 共用 */
  aiConfigServiceToken?: string;
  /** 内部 AI 配置读取超时（毫秒） */
  aiConfigTimeoutMs: number;
  /** 用户配置类型到 dsh provider route 的部署映射 */
  dshProviderOpenai: string;
  dshProviderClaude: string;
  dshProviderGlm: string;
  /**
   * 本地演示逃生舱：TECHHAVEN_ORG_ACCESS_ALLOW_ALL=1 时跳过「调用者属于目标组织」校验。
   * 仅允许 driver=mock（无真实引擎、无真实产品数据）时开启，用于本地跑通前端演示；
   * 其余情况下配置即启动失败，避免真实部署误配成「任意组织可建会话」。
   */
  orgAccessAllowAll: boolean;
  /**
   * 当前 Gateway 实例标识（TECHHAVEN_GATEWAY_INSTANCE_ID）。PG 部署时写入
   * agent_sessions.runner_id，用于归属 / 租约 / fencing（审查意见 F4）。
   * 缺省按 hostname:pid:random 自动生成；显式注入便于多副本联调。
   */
  instanceId?: string;
}

/** 配置错误（≈ services/techhaven-mcp/src/config.ts 的 ConfigError 同构孪生，防漂移） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayToken = env.TECHHAVEN_GATEWAY_TOKEN?.trim() ?? "";
  if (!gatewayToken) {
    throw new ConfigError("缺少 TECHHAVEN_GATEWAY_TOKEN（网关 API 的 Bearer 鉴权令牌）");
  }

  // 端口：空 = 默认；给了就必须是 1~65535 的整数（宁可起不来也不带病监听）
  let port = 3091;
  const portRaw = env.TECHHAVEN_GATEWAY_PORT?.trim() ?? "";
  if (portRaw) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ConfigError(`TECHHAVEN_GATEWAY_PORT 必须是 1~65535 的整数，收到：${portRaw}`);
    }
    port = parsed;
  }

  // 监听地址：默认回环。显式设为 0.0.0.0 / :: 才会监听所有网卡（仅供容器或反向代理跨机部署）
  const host = env.TECHHAVEN_GATEWAY_HOST?.trim() || "127.0.0.1";

  const driverRaw = (env.TECHHAVEN_ENGINE_DRIVER ?? "mock").trim().toLowerCase();
  if (driverRaw !== "mock" && driverRaw !== "dsh") {
    throw new ConfigError(`TECHHAVEN_ENGINE_DRIVER 只能是 mock | dsh，收到：${driverRaw}`);
  }
  const driver = driverRaw as EngineDriverKind;

  const dataDir = env.TECHHAVEN_GATEWAY_DATA_DIR?.trim() || "./data";

  const storeRaw = (env.TECHHAVEN_GATEWAY_STORE ?? "jsonl").trim().toLowerCase();
  if (storeRaw !== "jsonl" && storeRaw !== "postgres") {
    throw new ConfigError(`TECHHAVEN_GATEWAY_STORE 只能是 jsonl | postgres，收到：${storeRaw}`);
  }
  const store = storeRaw as GatewayStoreKind;
  const dbUrl = env.TECHHAVEN_GATEWAY_DB_URL?.trim() ?? "";
  if (store === "postgres" && !dbUrl) {
    throw new ConfigError("TECHHAVEN_GATEWAY_STORE=postgres 时必须设置 TECHHAVEN_GATEWAY_DB_URL");
  }
  const dbSchema = env.TECHHAVEN_GATEWAY_DB_SCHEMA?.trim() || "public";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbSchema)) {
    throw new ConfigError(`TECHHAVEN_GATEWAY_DB_SCHEMA 不是合法标识符：${dbSchema}`);
  }
  const proposalsFile = env.TECHHAVEN_PROPOSALS_FILE?.trim() || "../techhaven-mcp/audit/proposals.jsonl";

  // 配额：正整数；空 = 默认 3
  const maxRaw = (env.TECHHAVEN_MAX_SESSIONS_PER_ORG ?? "3").trim();
  const maxSessionsPerOrg = Number(maxRaw);
  if (!Number.isInteger(maxSessionsPerOrg) || maxSessionsPerOrg <= 0) {
    throw new ConfigError(`TECHHAVEN_MAX_SESSIONS_PER_ORG 必须是正整数，收到：${maxRaw}`);
  }

  // 终态会话驻留分钟数：正整数或 0（0 = 不淘汰）；空 = 默认 30
  const retentionRaw = env.TECHHAVEN_SESSION_RETENTION_MINUTES?.trim() || "30";
  const sessionRetentionMinutes = Number(retentionRaw);
  if (!Number.isInteger(sessionRetentionMinutes) || sessionRetentionMinutes < 0) {
    throw new ConfigError(`TECHHAVEN_SESSION_RETENTION_MINUTES 必须是正整数或 0（0 = 不淘汰），收到：${retentionRaw}`);
  }

  // 会话空闲超时分钟数：正整数或 0（0 = 关闭看门狗）；空 = 默认 30
  const idleRaw = env.TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES?.trim() || "30";
  const sessionIdleTimeoutMinutes = Number(idleRaw);
  if (!Number.isInteger(sessionIdleTimeoutMinutes) || sessionIdleTimeoutMinutes < 0) {
    throw new ConfigError(`TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES 必须是正整数或 0（0 = 关闭），收到：${idleRaw}`);
  }

  const aiConfigUrl = env.TECHHAVEN_AI_CONFIG_URL?.trim() || undefined;
  const aiConfigServiceToken = env.TECHHAVEN_AI_CONFIG_SERVICE_TOKEN?.trim() || undefined;
  if ((aiConfigUrl === undefined) !== (aiConfigServiceToken === undefined)) {
    throw new ConfigError("TECHHAVEN_AI_CONFIG_URL 与 TECHHAVEN_AI_CONFIG_SERVICE_TOKEN 必须同时设置");
  }
  if (aiConfigUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(aiConfigUrl);
    } catch {
      throw new ConfigError("TECHHAVEN_AI_CONFIG_URL 不是合法 URL");
    }
    const isLoopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      throw new ConfigError("TECHHAVEN_AI_CONFIG_URL 必须使用 HTTPS（本机回环地址除外）");
    }
  }
  const aiConfigTimeoutRaw = env.TECHHAVEN_AI_CONFIG_TIMEOUT_MS?.trim() || "5000";
  const aiConfigTimeoutMs = Number(aiConfigTimeoutRaw);
  if (!Number.isInteger(aiConfigTimeoutMs) || aiConfigTimeoutMs < 100 || aiConfigTimeoutMs > 60_000) {
    throw new ConfigError(`TECHHAVEN_AI_CONFIG_TIMEOUT_MS 必须是 100~60000 的整数，收到：${aiConfigTimeoutRaw}`);
  }

  // 组织授权逃生舱：只允许 mock 驱动显式开启（真实链路必须走可信组织授权服务）
  const orgAccessAllowAllRaw = (env.TECHHAVEN_ORG_ACCESS_ALLOW_ALL ?? "").trim();
  if (orgAccessAllowAllRaw !== "" && orgAccessAllowAllRaw !== "0" && orgAccessAllowAllRaw !== "1") {
    throw new ConfigError(`TECHHAVEN_ORG_ACCESS_ALLOW_ALL 只能是 0 | 1，收到：${orgAccessAllowAllRaw}`);
  }
  const orgAccessAllowAll = orgAccessAllowAllRaw === "1";
  if (orgAccessAllowAll && driver !== "mock") {
    throw new ConfigError("TECHHAVEN_ORG_ACCESS_ALLOW_ALL=1 仅允许 TECHHAVEN_ENGINE_DRIVER=mock 的本地演示，真实驱动必须配置组织授权服务");
  }

  // 实例标识（PG 归属用）：缺省自动生成；显式注入便于多副本联调
  const instanceIdRaw = env.TECHHAVEN_GATEWAY_INSTANCE_ID?.trim() ?? "";
  if (instanceIdRaw !== "" && (instanceIdRaw.length < 4 || instanceIdRaw.length > 128)) {
    throw new ConfigError(`TECHHAVEN_GATEWAY_INSTANCE_ID 必须是 4~128 字符的标识符，收到长度：${instanceIdRaw.length}`);
  }

  const providerId = (name: string, fallback: string): string => {
    const value = env[name]?.trim() || fallback;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new ConfigError(`${name} 不是合法的 dsh provider id：${value}`);
    }
    return value;
  };

  return {
    gatewayToken,
    port,
    host,
    driver,
    dataDir,
    store,
    dbUrl,
    dbSchema,
    proposalsFile,
    maxSessionsPerOrg,
    sessionRetentionMinutes,
    sessionIdleTimeoutMinutes,
    // dsh 驱动选项：透传收集，经 index.ts 的 DshSdkDriver 构造器统一下发
    dshBin: env.TECHHAVEN_DSH_BIN?.trim() || undefined,
    dshProfile: env.TECHHAVEN_DSH_PROFILE?.trim() || undefined,
    dshHome: env.TECHHAVEN_DSH_HOME?.trim() || undefined,
    aiConfigUrl,
    aiConfigServiceToken,
    aiConfigTimeoutMs,
    dshProviderOpenai: providerId("TECHHAVEN_DSH_PROVIDER_OPENAI", "openai"),
    dshProviderClaude: providerId("TECHHAVEN_DSH_PROVIDER_CLAUDE", "anthropic"),
    dshProviderGlm: providerId("TECHHAVEN_DSH_PROVIDER_GLM", "glm"),
    orgAccessAllowAll,
    instanceId: instanceIdRaw === "" ? undefined : instanceIdRaw,
  };
}
