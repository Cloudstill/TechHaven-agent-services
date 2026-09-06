/**
 * TechHaven Agent Gateway 入口（P1 骨架，TH-RFC-001 §05.1）：
 * 载入配置 → 组装引擎驱动 → 会话注册表 → HTTP/SSE 服务 → 优雅关闭。
 */
import { loadConfig, ConfigError, type Config } from "./config.js";
import { log } from "./log.js";
import { errorMessage } from "./util.js";
import { MockDriver } from "./drivers/mock.js";
import { DshSdkDriver, type DshSdkDriverOptions } from "./drivers/dsh.js";
import { SessionRegistry } from "./sessions.js";
import { createGatewayServer } from "./http.js";
import type { EngineDriver } from "./types.js";
import { JsonlProposalPort, PgProposalPort, type ProposalPort } from "./proposals.js";
import { HttpAiConfigResolver, type AiConfigResolver } from "./aiConfig.js";
import { AiConfigStore, StoreAiConfigResolver } from "./aiConfigStore.js";
import { loadMasterKeys } from "./aiConfigCrypto.js";
import { AiConfigOrgAccess, LocalDemoOrgAccess, type OrgAccessPort } from "./orgAccess.js";

/**
 * 组装引擎驱动：mock 直接构造；dsh 静态导入构造（drivers/dsh.ts 已交付，
 * 恢复 tsc 对其的静态检查；SDK 包本身仍由 dsh.ts 在 startSession 阶段动态加载，包缺失不影响构建）。
 */
function createDriver(config: Config): EngineDriver {
  if (config.driver === "mock") return new MockDriver();
  try {
    // 选项键名对齐 DshSdkDriverOptions：profile（非 dshProfile）
    const options: DshSdkDriverOptions = {
      dshBin: config.dshBin,
      profile: config.dshProfile,
      dshHome: config.dshHome,
    };
    return new DshSdkDriver(options);
  } catch (err) {
    log(`dsh 驱动初始化失败（SDK 未安装或初始化失败，安装与排查见 services/techhaven-gateway/docs/DSH_SDK.md）：${errorMessage(err)}`);
    log("如需本地演示，请设置 TECHHAVEN_ENGINE_DRIVER=mock");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) log(`配置错误：${err.message}`);
    else log("配置载入失败：", err);
    process.exit(1);
  }

  log(
    `启动：driver=${config.driver} store=${config.store} port=${config.port} dataDir=${config.dataDir} ` +
      `maxSessionsPerOrg=${config.maxSessionsPerOrg} ` +
      `sessionRetentionMinutes=${config.sessionRetentionMinutes} sessionIdleTimeoutMinutes=${config.sessionIdleTimeoutMinutes}`,
  );

  const driver = createDriver(config);

  let pgStore;
  let proposalPort: ProposalPort;
  let aiConfigStore: AiConfigStore | undefined;
  if (config.store === "postgres") {
    const { GatewayPgStore } = await import("./pgStore.js");
    // 归属与租约：把当前实例 ID 注入 pgStore，启动时强制单活（advisory_lock），
    // 防止多实例同时接管同一份 agent_sessions（审查意见 F4）。
    pgStore = await GatewayPgStore.connect(config.dbUrl, config.dbSchema, {
      ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
    });
    log(`PG 单活门禁已启用，归属 instanceId=${pgStore.currentInstanceId}`);
    proposalPort = await PgProposalPort.connect(config.dbUrl, config.dbSchema);
    log("PostgreSQL authoritative 已连接：session/event 先提交 PG，JSONL 仅作 spool");
    log("PostgreSQL proposal control API 已连接：审批决定写入 agent_write_proposals");
    // AI 配置资产：Agent DB v0.4 表 + 主密钥齐全时启用；缺失时降级到旧链路，不阻断启动
    try {
      const keys = loadMasterKeys();
      aiConfigStore = await AiConfigStore.connect(config.dbUrl, keys, config.dbSchema);
      log("AI 配置资产已启用：一账号多套配置 / 组织共享 / 用量与配额（Agent DB v0.4）");
    } catch (err) {
      if (process.env.TECHHAVEN_AI_CONFIG_MASTER_KEY?.trim()) throw err;
      log(`AI 配置资产未启用（${errorMessage(err)}）；用户 AI 配置将走产品后端接口`);
    }
  } else {
    proposalPort = new JsonlProposalPort(config.proposalsFile);
    log(`JSONL proposal control API 已连接：${config.proposalsFile}`);
  }

  const registry = await SessionRegistry.open(driver, {
    dataDir: config.dataDir,
    maxSessionsPerOrg: config.maxSessionsPerOrg,
    sessionRetentionMinutes: config.sessionRetentionMinutes,
    sessionIdleTimeoutMinutes: config.sessionIdleTimeoutMinutes,
    pgStore,
  });
  let aiConfigResolver: AiConfigResolver | undefined;
  if (aiConfigStore) {
    // 优先走 Agent DB 配置资产：按用户解析多套配置，密钥只在服务端流转
    aiConfigResolver = new StoreAiConfigResolver(aiConfigStore, {
      openai: config.dshProviderOpenai,
      claude: config.dshProviderClaude,
      glm: config.dshProviderGlm,
    });
    log("用户 AI 配置解析已启用：Agent DB 配置资产（个人优先，回落组织共享）");
  } else if (config.driver === "dsh" && config.aiConfigUrl && config.aiConfigServiceToken) {
    aiConfigResolver = new HttpAiConfigResolver({
      endpoint: config.aiConfigUrl,
      serviceToken: config.aiConfigServiceToken,
      timeoutMs: config.aiConfigTimeoutMs,
      providerIds: {
        openai: config.dshProviderOpenai,
        claude: config.dshProviderClaude,
        glm: config.dshProviderGlm,
      },
    });
    log(`用户 AI 配置解析已启用：${new URL(config.aiConfigUrl).origin}`);
  } else if (config.driver === "dsh") {
    log("用户 AI 配置解析未启用：dsh 将沿用 Gateway 进程级模型凭据");
  }

  // 组织授权（审查意见 F1）：会话创建前校验「用户属于目标组织」。
  // 有 Agent DB 配置资产 → 以 ai_org_memberships 为权威；mock driver 是本地演示 /
  // CI 冒烟模式、没有真实写入面，默认走演示放行（否则开箱即 503，CI smoke 回归）；
  // dsh 等真实 driver 无授权源时保持 fail-closed。
  let orgAccess: OrgAccessPort | undefined;
  if (aiConfigStore) {
    orgAccess = new AiConfigOrgAccess(aiConfigStore);
    log("组织授权已启用：会话创建前校验 ai_org_memberships 成员关系");
  } else if (config.driver === "mock") {
    orgAccess = new LocalDemoOrgAccess(log);
    log("组织授权：mock driver 演示模式默认放行，不适用于真实部署");
  } else {
    log("警告：未配置可信组织授权服务，POST /v1/sessions 将返回 503（fail-closed）");
  }

  const server = createGatewayServer(config, registry, proposalPort, aiConfigResolver, aiConfigStore, orgAccess);
  server.on("error", (err) => {
    log(`HTTP 服务错误（端口 ${config.port} 可能被占用）：`, err);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log(`监听 http://${config.host}:${config.port}（鉴权：Authorization: Bearer <TECHHAVEN_GATEWAY_TOKEN>）`);
  });

  // 兜底：泵与订阅链路已各自容错；这两类全局异常只记日志，避免静默丢失
  process.on("unhandledRejection", (reason) => log("未处理的 Promise 拒绝：", reason));
  process.on("uncaughtException", (err) => {
    log("未捕获异常，退出：", err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，优雅关闭…`);
    server.close(() => log("HTTP 服务已关闭"));
    // 关闭全部 SSE 订阅 + dispose 引擎句柄 / 驱动 + 冲刷 JSONL 写流；5s 兜底强制退出（防 SSE 连接拖延）
    void Promise.allSettled([registry.dispose(), driver.dispose(), proposalPort.close()]).then(() => {
      log("已释放全部会话与驱动，退出");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("启动失败：", err);
  process.exit(1);
});
