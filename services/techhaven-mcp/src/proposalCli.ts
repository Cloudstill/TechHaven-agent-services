#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_PROPOSAL_TTL_MINUTES, DEFAULT_PROPOSALS_FILE } from "./config.js";
import { ProposalStore, type ProposalRepository } from "./proposals/store.js";
import { log } from "./log.js";

/**
 * 写提案人工审批 CLI（staged 写模式的「人批」入口；TH-RFC-001 §07「事前守护」）
 *
 *   npm run proposal -- list
 *   npm run proposal -- approve <提案ID>
 *   npm run proposal -- reject <提案ID> [原因]
 *
 * 与 MCP server 通过同一份 JSONL 事件文件交接：CLI 追加批准事件后，
 * server 内 proposal worker 会主动重新校验并应用；get_proposal 只查询状态。
 */

const USAGE = `用法：
  npm run proposal -- list
  npm run proposal -- approve <提案ID>
  npm run proposal -- reject <提案ID> [原因]
环境变量：TECHHAVEN_PROPOSALS_FILE（默认 ./audit/proposals.jsonl）、
          TECHHAVEN_PROPOSAL_TTL_MINUTES（默认 30，仅影响 server 侧新建提案的过期时间）、
          TECHHAVEN_DB_URL + TECHHAVEN_APPROVAL_ORG_ID（设置后审批直接以 PostgreSQL 为权威）、
          TECHHAVEN_APPROVER_ID（可选，记录批准/拒绝用户 ID）`;

/** 打开提案存储。不走 loadConfig：CLI 是人工工具，不需要 agent token / 后端配置，只读提案存储相关两项 */
async function openStore(): Promise<{ store: ProposalRepository; close: () => Promise<void> }> {
  const file = process.env.TECHHAVEN_PROPOSALS_FILE?.trim() || DEFAULT_PROPOSALS_FILE;
  const ttlRaw = process.env.TECHHAVEN_PROPOSAL_TTL_MINUTES?.trim() || String(DEFAULT_PROPOSAL_TTL_MINUTES);
  const ttl = Number(ttlRaw);
  const normalizedTtl = Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_PROPOSAL_TTL_MINUTES;
  const dbUrl = process.env.TECHHAVEN_DB_URL?.trim();
  if (!dbUrl) {
    return { store: new ProposalStore(file, normalizedTtl), close: async () => undefined };
  }
  const orgId = Number(process.env.TECHHAVEN_APPROVAL_ORG_ID);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error("PostgreSQL 审批模式需要正整数 TECHHAVEN_APPROVAL_ORG_ID");
  }
  const [{ default: pg }, { PgProposalRepository }] = await Promise.all([import("pg"), import("./proposals/pgStore.js")]);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 5_000 });
  await pool.query("SELECT 1");
  return { store: new PgProposalRepository(pool, normalizedTtl, orgId), close: () => pool.end() };
}

async function listCmd(store: ProposalRepository): Promise<void> {
  const rows = await store.list();
  if (rows.length === 0) {
    console.log("（暂无提案）");
    return;
  }
  console.log(`共 ${rows.length} 条提案：`);
  for (const { detail, status } of rows) {
    console.log(
      [
        `  ${detail.id}  [${status}]  ${detail.kind}#${detail.subjectHashId}  ${detail.fromStatus} → ${detail.toStatus}`,
        `      原因：${detail.reason}`,
        `      过期：${detail.expiresAt}`,
      ].join("\n"),
    );
  }
}

async function approveCmd(store: ProposalRepository, id: string): Promise<void> {
  const state = await store.getState(id);
  if (state.status === "unknown") {
    console.error(`✗ 提案不存在：${id}（可用 list 查看全部提案）`);
    process.exit(1);
  }
  if (state.status !== "pending") {
    console.error(`✗ 提案 ${id} 当前状态为 ${state.status}，只有 pending 可以批准`);
    process.exit(1);
  }
  const approver = process.env.TECHHAVEN_APPROVER_ID?.trim();
  await store.appendEvent("approved", id, approver ? `user:${approver}` : "user:cli");
  console.log(
    `✓ 已批准 ${id}（${state.detail.kind}#${state.detail.subjectHashId} ${state.detail.fromStatus} → ${state.detail.toStatus}）`,
  );
  console.log("  server proposal worker 将主动校验状态机并应用；可用 get_proposal 查询结果。");
}

async function rejectCmd(store: ProposalRepository, id: string, reason: string): Promise<void> {
  const state = await store.getState(id);
  if (state.status === "unknown") {
    console.error(`✗ 提案不存在：${id}（可用 list 查看全部提案）`);
    process.exit(1);
  }
  if (state.status !== "pending") {
    console.error(`✗ 提案 ${id} 当前状态为 ${state.status}，只有 pending 可以拒绝`);
    process.exit(1);
  }
  const approver = process.env.TECHHAVEN_APPROVER_ID?.trim();
  await store.appendEvent("rejected", id, approver ? `user:${approver}` : "user:cli", reason || undefined);
  console.log(`✓ 已拒绝 ${id}${reason ? `（原因：${reason}）` : ""}`);
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const cmd = positionals[0];
  const opened = await openStore();
  const store = opened.store;

  try {
    if (cmd === "list") {
      await listCmd(store);
      return;
    }

    if (cmd === "approve") {
      const id = positionals[1];
      if (!id) {
        console.error("approve 需要提案 ID 参数");
        console.error(USAGE);
        process.exitCode = 1;
        return;
      }
      await approveCmd(store, id);
      return;
    }

    if (cmd === "reject") {
      const id = positionals[1];
      if (!id) {
        console.error("reject 需要提案 ID 参数");
        console.error(USAGE);
        process.exitCode = 1;
        return;
      }
      const reason = positionals.slice(2).join(" ").trim();
      await rejectCmd(store, id, reason);
      return;
    }

    console.error(USAGE);
    process.exitCode = 1;
  } finally {
    await opened.close();
  }
}

main().catch((e) => {
  log(e);
  process.exit(1);
});
