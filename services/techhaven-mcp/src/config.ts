export type BackendMode = "mock" | "http" | "bridge";
/** 写模式：direct=写工具直接生效（P0 现状）；staged=写操作先建提案等待人工批准（TH-RFC-001 §07） */
export type WriteMode = "direct" | "staged";
export type DbMode = "mirror" | "authoritative";

/** 提案事件存储默认路径（proposalCli.ts 共用，避免两处默认值漂移） */
export const DEFAULT_PROPOSALS_FILE = "./audit/proposals.jsonl";
/** 提案未决过期默认分钟数（proposalCli.ts 共用） */
export const DEFAULT_PROPOSAL_TTL_MINUTES = 30;
/** staged 模式分级审批默认清单（逗号分隔字符串；仅列出的写工具仍走提案审批） */
export const DEFAULT_WRITE_STAGED_TOOLS = "update_ticket_status";

export interface Config {
  agentToken: string;
  tokenSecret: string;
  backend: BackendMode;
  apiBaseUrl: string;
  serviceToken: string;
  apiTimeoutMs: number;
  /** 独立 Agent Bridge 地址与内部 Bearer（backend=bridge 时必填） */
  bridgeUrl: string;
  bridgeToken: string;
  auditFile: string;
  /** PostgreSQL 连接串（TECHHAVEN_DB_URL）；空串 = 不接 DB：仅 JSONL 审计 + mock 语义层 + 提案只落 JSONL。
   *  DB 就绪时审计双写 / 写提案落库 / 语义层 DB Provider 三者同时启用（共用 PgContext） */
  dbUrl: string;
  /** mirror=JSONL 权威、PG 可选镜像；authoritative=PG proposal 权威且连接失败拒绝启动 */
  dbMode: DbMode;
  /** agent 身份在 DB（agent_identities.name）中的名字（TECHHAVEN_AGENT_NAME） */
  agentName: string;
  /** 写模式（TECHHAVEN_WRITE_MODE），见 WriteMode */
  writeMode: WriteMode;
  /** 写提案事件存储路径（TECHHAVEN_PROPOSALS_FILE，JSONL append-only；staged 模式使用） */
  proposalsFile: string;
  /** 提案未决过期分钟数（TECHHAVEN_PROPOSAL_TTL_MINUTES，正整数；过期 = 默认拒绝） */
  proposalTtlMinutes: number;
  /** staged 模式分级审批清单（TECHHAVEN_WRITE_STAGED_TOOLS，逗号分隔）：
   *  仅列出的写工具在 staged 模式仍走提案审批，未列入的写工具即使 staged 也直写 */
  stagedTools: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const agentToken = env.TECHHAVEN_AGENT_TOKEN?.trim() ?? "";
  if (!agentToken) {
    throw new ConfigError("缺少 TECHHAVEN_AGENT_TOKEN（用 `npm run token -- issue ...` 签发后注入）");
  }
  const tokenSecret = env.TECHHAVEN_TOKEN_SECRET?.trim() ?? "";
  if (!tokenSecret) {
    throw new ConfigError("缺少 TECHHAVEN_TOKEN_SECRET");
  }

  const backendRaw = (env.TECHHAVEN_BACKEND ?? "mock").trim().toLowerCase();
  if (backendRaw !== "mock" && backendRaw !== "http" && backendRaw !== "bridge") {
    throw new ConfigError(`TECHHAVEN_BACKEND 只能是 mock | http | bridge，收到：${backendRaw}`);
  }
  const backend = backendRaw as BackendMode;

  const apiBaseUrl = env.TECHHAVEN_API_BASE_URL?.trim() || "https://techhaven.website/api/v1";
  const serviceToken = env.TECHHAVEN_SERVICE_TOKEN?.trim() ?? "";
  if (backend === "http" && !serviceToken) {
    throw new ConfigError("http 模式需要 TECHHAVEN_SERVICE_TOKEN（服务端凭据，不使用 agent token）");
  }
  const bridgeUrl = env.TECHHAVEN_BRIDGE_URL?.trim().replace(/\/+$/, "") ?? "";
  const bridgeToken = env.TECHHAVEN_BRIDGE_TOKEN?.trim() ?? "";
  if (backend === "bridge" && (!bridgeUrl || !bridgeToken)) {
    throw new ConfigError("bridge 模式需要 TECHHAVEN_BRIDGE_URL 与 TECHHAVEN_BRIDGE_TOKEN");
  }
  const apiTimeoutRaw = (env.TECHHAVEN_API_TIMEOUT_MS ?? "5000").trim();
  const apiTimeoutMs = Number(apiTimeoutRaw);
  if (!Number.isInteger(apiTimeoutMs) || apiTimeoutMs < 100 || apiTimeoutMs > 60_000) {
    throw new ConfigError(`TECHHAVEN_API_TIMEOUT_MS 必须是 100~60000 的整数毫秒，收到：${apiTimeoutRaw}`);
  }

  const writeModeRaw = (env.TECHHAVEN_WRITE_MODE ?? "direct").trim().toLowerCase();
  if (writeModeRaw !== "direct" && writeModeRaw !== "staged") {
    throw new ConfigError(`TECHHAVEN_WRITE_MODE 只能是 direct | staged，收到：${writeModeRaw}`);
  }
  const writeMode = writeModeRaw as WriteMode;

  const dbModeRaw = (env.TECHHAVEN_DB_MODE ?? "mirror").trim().toLowerCase();
  if (dbModeRaw !== "mirror" && dbModeRaw !== "authoritative") {
    throw new ConfigError(`TECHHAVEN_DB_MODE 只能是 mirror | authoritative，收到：${dbModeRaw}`);
  }
  const dbMode = dbModeRaw as DbMode;
  const dbUrl = env.TECHHAVEN_DB_URL?.trim() ?? "";
  if (dbMode === "authoritative" && !dbUrl) {
    throw new ConfigError("TECHHAVEN_DB_MODE=authoritative 时必须设置 TECHHAVEN_DB_URL");
  }
  if (dbMode === "authoritative" && writeMode !== "staged") {
    throw new ConfigError("TECHHAVEN_DB_MODE=authoritative 时必须使用 TECHHAVEN_WRITE_MODE=staged，禁止未经 proposal 的 direct 写");
  }

  const proposalsFile = env.TECHHAVEN_PROPOSALS_FILE?.trim() || DEFAULT_PROPOSALS_FILE;

  // 分级审批清单：逗号分隔的工具名。未设置 = 默认仅 update_ticket_status 走提案；
  // 显式设为空串 = staged 模式下所有写工具都直写（灰度用），不做报错
  const stagedTools = (env.TECHHAVEN_WRITE_STAGED_TOOLS ?? DEFAULT_WRITE_STAGED_TOOLS)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 提案未决时限：正整数分钟；空/非数字/非正整数一律拒绝启动（宁可起不来也不带病跑审批流）
  const ttlRaw = (env.TECHHAVEN_PROPOSAL_TTL_MINUTES ?? String(DEFAULT_PROPOSAL_TTL_MINUTES)).trim();
  const proposalTtlMinutes = Number(ttlRaw);
  if (!Number.isInteger(proposalTtlMinutes) || proposalTtlMinutes <= 0) {
    throw new ConfigError(`TECHHAVEN_PROPOSAL_TTL_MINUTES 必须是正整数（分钟），收到：${env.TECHHAVEN_PROPOSAL_TTL_MINUTES ?? ""}`);
  }

  return {
    agentToken,
    tokenSecret,
    backend,
    apiBaseUrl,
    serviceToken,
    apiTimeoutMs,
    bridgeUrl,
    bridgeToken,
    auditFile: env.TECHHAVEN_AUDIT_FILE?.trim() || "./audit/agent-audit.jsonl",
    dbUrl,
    dbMode,
    agentName: env.TECHHAVEN_AGENT_NAME?.trim() || "techhaven-mcp-poc",
    writeMode,
    proposalsFile,
    proposalTtlMinutes,
    stagedTools,
  };
}
