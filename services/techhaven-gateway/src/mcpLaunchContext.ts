/**
 * 会话级 MCP 启动上下文（审查意见 F6）。
 *
 * 问题：配置解析器只生成「模型供应商环境」（OPENAI_API_KEY 等），dsh driver 再用
 * `SAFE_CHILD_ENV_KEYS` + 这份 env 构造子进程环境（见 drivers/dsh.ts）。
 * 这个对象里没有 TECHHAVEN_AGENT_TOKEN / TECHHAVEN_TOKEN_SECRET，而随附的
 * dsh MCP 配置（services/techhaven-mcp/dsh/dsh-mcp-config.example.yml）恰好
 * 通过 process.env 读取这两个值，MCP 启动要求它们存在。
 * 又因「显式 env 会整体替换父环境」（docs/DSH_SDK.md），光靠
 * 「先 export 再启动 Gateway」不会让它们进入 dsh 子进程。
 *
 * 修复：由 Gateway（可信服务侧）为**每个会话**构造一份最小 MCP 启动上下文，
 * 显式绑定 sid 与已授权 org，并把最小集合的专用凭据一并下发。
 * 保留环境隔离：不恢复父环境，只放行明确列出的键。
 */
import { log } from "./log.js";

/** 会话级 MCP 启动必需的凭据键（随附 dsh MCP 配置从 process.env 读取这两个值） */
export const SESSION_MCP_CREDENTIAL_KEYS = ["TECHHAVEN_AGENT_TOKEN", "TECHHAVEN_TOKEN_SECRET"] as const;

/** 会话绑定键：让 MCP 侧能核对「本次 MCP 会话属于哪个 Gateway 会话 / 组织」 */
export const SESSION_MCP_BINDING_KEYS = ["TECHHAVEN_SESSION_SID", "TECHHAVEN_SESSION_ORG_ID"] as const;

export interface SessionMcpContext {
  /** Gateway 会话 ID（sid） */
  sid: string;
  /** 已通过组织成员校验的 orgId */
  orgId: number;
  /** 最小 scopes；省略则不下发该键 */
  scopes?: readonly string[];
}

export interface SessionMcpEnv {
  env: Record<string, string>;
  /** 缺少的必需凭据键：调用方应记录告警（MCP 初始化会在 dsh 侧失败） */
  missing: string[];
}

/**
 * 构造会话级 MCP 启动环境。
 *
 * 只放行明确列出的键 —— 不是 process.env 的全量拷贝，避免把 Gateway 的其他
 * ambient secret（AI 主密钥、服务令牌……）一并带进 dsh 子进程。
 */
export function buildSessionMcpEnv(context: SessionMcpContext, source: NodeJS.ProcessEnv = process.env): SessionMcpEnv {
  const env: Record<string, string> = {
    TECHHAVEN_SESSION_SID: context.sid,
    TECHHAVEN_SESSION_ORG_ID: String(context.orgId),
  };
  if (context.scopes && context.scopes.length > 0) {
    env.TECHHAVEN_MCP_SCOPES = context.scopes.join(",");
  }

  const missing: string[] = [];
  for (const key of SESSION_MCP_CREDENTIAL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") env[key] = value;
    else missing.push(key);
  }
  return { env, missing };
}

/**
 * 把会话级 MCP 上下文并入运行时配置；凭据缺失时记录告警（不阻断会话，
 * 失败会在 dsh 的 MCP 初始化阶段如实暴露）。
 */
export function withSessionMcpContext(
  runtimeConfig: { env: Record<string, string>; mcpEnv?: Record<string, string> },
  context: SessionMcpContext,
  source: NodeJS.ProcessEnv = process.env,
): void {
  const { env, missing } = buildSessionMcpEnv(context, source);
  runtimeConfig.mcpEnv = { ...runtimeConfig.mcpEnv, ...env };
  if (missing.length > 0) {
    log(
      `会话 ${context.sid} 的 MCP 启动上下文缺少 ${missing.join(" / ")}：` +
        `启用用户模型配置时 dsh 子进程环境会整体替换父环境，随附 MCP 配置将无法初始化（见 docs/DSH_SDK.md）`,
    );
  }
}
