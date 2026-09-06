#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { verifyAgentToken } from "./auth/agentToken.js";
import { MockTechHavenClient } from "./techhaven/mockClient.js";
import { HttpTechHavenClient } from "./techhaven/httpClient.js";
import { BridgeTechHavenClient } from "./techhaven/bridgeClient.js";
import { AuditLog } from "./audit.js";
import { ProposalStore, type ProposalRepository } from "./proposals/store.js";
import { ProposalWorker } from "./proposals/worker.js";
import { registerTools } from "./tools/index.js";
import { MockSemanticsProvider } from "./semantics/mockProvider.js";
import type { SemanticsProvider } from "./semantics/types.js";
import type { PgContext } from "./db/context.js";
import { log } from "./log.js";

const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();

  const verified = verifyAgentToken(config.agentToken, config.tokenSecret);
  if (!verified.ok) {
    log("agent token 校验失败：", verified.reason);
    process.exit(1);
  }
  const session = verified.payload;

  const client =
    config.backend === "http"
      ? new HttpTechHavenClient({
          apiBaseUrl: config.apiBaseUrl,
          serviceToken: config.serviceToken,
          timeoutMs: config.apiTimeoutMs,
        })
      : config.backend === "bridge"
        ? new BridgeTechHavenClient({
            bridgeUrl: config.bridgeUrl,
            bridgeToken: config.bridgeToken,
            timeoutMs: config.apiTimeoutMs,
            sessionId: session.sid,
            orgId: session.org,
          })
        : new MockTechHavenClient();

  // P2 持久化：TECHHAVEN_DB_URL 非空时建立 DB 会话上下文（pool + agent_identities/agent_sessions 锚点），
  // 审计双写 / 写提案落库 / 语义层 DB Provider 三者共用；失败整体降级为
  // 「仅 JSONL 审计 + mock 语义层 + 提案只落 JSONL」。pg 依赖只在此分支惰性加载。
  let ctx: PgContext | null = null;
  if (config.dbUrl) {
    const { PgContext } = await import("./db/context.js");
    try {
      ctx = await PgContext.create(config.dbUrl, config.agentName, session.org, session.sid, SERVER_VERSION);
      log(`DB 已连接（identity=${config.agentName} sid=${session.sid} org=${session.org}）`);
    } catch (error) {
      if (config.dbMode === "authoritative") throw error;
      // 错误细节已在 PgContext.create 里记过 stderr；这里只提示降级
      log("警告：DB 初始化失败，本次会话降级为仅 JSONL 审计 + mock 语义层");
    }
  }

  // 审计：JSONL 永远是主审计；DB 就绪时双写 agent_tool_calls
  let audit: AuditLog;
  // 语义层：DB 就绪时读 semantic_* 表（数据需人工策展，查无即 notFound）；否则用人工策展 mock。
  // 接入真实后端语义接口后，再替换为远程 Provider（接口不变）
  let semantics: SemanticsProvider;
  // 写提案存储（staged 写模式：提案暂存 → 人批 → 应用；direct 模式下仅构造不使用）。
  // mirror 模式以 JSONL 为权威并镜像 PG；authoritative 模式只接受 PG 事务写。
  let proposals: ProposalRepository;

  if (ctx) {
    const { DbAuditSink } = await import("./audit/dbSink.js");
    const { DbSemanticsProvider } = await import("./semantics/dbProvider.js");
    audit = new AuditLog(config.auditFile, new DbAuditSink(ctx));
    semantics = new DbSemanticsProvider({ ctx, orgId: session.org });
    if (config.dbMode === "authoritative") {
      const { PgProposalRepository } = await import("./proposals/pgStore.js");
      proposals = new PgProposalRepository(ctx.pool, config.proposalTtlMinutes, session.org);
      log("DB authoritative 已启用：agent_write_proposals 是 proposal 唯一权威；连接/事务失败将关闭写路径");
    } else {
      const { ProposalDbSink } = await import("./proposals/dbSink.js");
      proposals = new ProposalStore(config.proposalsFile, config.proposalTtlMinutes, new ProposalDbSink(ctx));
      log("DB mirror 已启用：审计/提案双写 + 语义层 DB Provider；JSONL 仍是 proposal 权威");
    }
  } else {
    audit = new AuditLog(config.auditFile);
    semantics = new MockSemanticsProvider();
    proposals = new ProposalStore(config.proposalsFile, config.proposalTtlMinutes);
  }

  const server = new McpServer({ name: "techhaven-mcp", version: SERVER_VERSION });
  registerTools(server, {
    client,
    session,
    audit,
    semantics,
    proposals,
    writeMode: config.writeMode,
    stagedTools: config.stagedTools,
  });

  const proposalWorker =
    config.writeMode === "staged"
      ? new ProposalWorker({
          store: proposals,
          client,
          sessionId: session.sid,
          orgId: session.org,
        })
      : null;
  proposalWorker?.start();

  await server.connect(new StdioServerTransport());
  log(
    `已连接（mode=${config.backend} write=${config.writeMode} sid=${session.sid} org=${session.org} scopes=${session.scopes.join(",")}）`,
  );
}

main().catch((err) => {
  log("启动失败:", err);
  process.exit(1);
});
