/**
 * staged 写模式端到端冒烟：验证 update_ticket_status 在 staged 模式下
 * 「提案暂存（pending）→ 人工批准 → server worker 主动应用」的完整闭环（TH-RFC-001 ADR-04）。
 *
 * 与 smoke.ts 的区别：server 以 TECHHAVEN_WRITE_MODE=staged 启动；批准一步由本进程
 * 直接 import ProposalStore 写入 approved 事件，模拟人工 CLI（不经过 server）。
 *
 *   npm run smoke   （先跑 direct 模式冒烟，再跑本文件）
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { signAgentToken } from "./auth/agentToken.js";
import { encodeId } from "./hashid.js";
import { ProposalStore } from "./proposals/store.js";

const SECRET = "smoke-secret";
const PROTOCOL = "2025-06-18";
// 与 server 子进程 env 保持一致；每次运行前清空，避免上次的提案事件污染折叠结果
const PROPOSALS_FILE = "./audit/smoke-proposals.jsonl";

interface JsonRpcResp {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

function tryParseProposal(text: string): { proposal?: { id?: string } } | null {
  try {
    return JSON.parse(text) as { proposal?: { id?: string } };
  } catch {
    return null; // 错误响应是纯文本，不是 JSON
  }
}

async function main(): Promise<void> {
  rmSync(PROPOSALS_FILE, { force: true });

  const now = Math.floor(Date.now() / 1000);
  const token = signAgentToken(
    { v: 1, sid: "smoke-staged-1", org: 1, scopes: ["rd:read", "rd:write"], iat: now, exp: now + 3600 },
    SECRET,
  );

  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:")], {
    env: {
      ...process.env,
      TECHHAVEN_AGENT_TOKEN: token,
      TECHHAVEN_TOKEN_SECRET: SECRET,
      TECHHAVEN_BACKEND: "mock",
      TECHHAVEN_WRITE_MODE: "staged",
      TECHHAVEN_PROPOSALS_FILE: PROPOSALS_FILE,
      TECHHAVEN_AUDIT_FILE: "./audit/smoke-audit-staged.jsonl",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (d: Buffer) => (stderrBuf += d.toString()));

  const pending = new Map<number, (r: JsonRpcResp) => void>();
  let lineBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString();
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResp;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // 忽略非 JSON 行
      }
    }
  });

  function request(id: number, method: string, params?: unknown): Promise<JsonRpcResp> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`请求超时：${method}`)), 15_000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const failures: string[] = [];
  function check(name: string, cond: boolean, detail?: string): void {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` —— ${detail ?? ""}`}`);
    if (!cond) failures.push(name);
  }

  try {
    // 1. 握手
    const init = await request(1, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "smoke-staged", version: "0.0.0" },
    });
    check("initialize 握手", init.result?.serverInfo?.name === "techhaven-mcp", JSON.stringify(init));
    notify("notifications/initialized");

    // 2. 工具清单（staged 模式下应额外看到 get_proposal）
    const list = await request(2, "tools/list", {});
    const names: string[] = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
    const expected = [
      "get_ticket",
      "list_my_tickets",
      "search_requirements",
      "get_trend_summary",
      "get_semantics",
      "get_proposal",
      "update_ticket_status",
    ];
    check(
      "tools/list 含全部工具（含 get_proposal）",
      expected.every((n) => names.includes(n)),
      names.join(","),
    );

    // 3. 前置基线：bug #1 初始为 new
    const bug1Hash = encodeId(1, "bug");
    const base = await request(3, "tools/call", { name: "get_ticket", arguments: { kind: "bug", id: bug1Hash } });
    const baseText: string = base.result?.content?.[0]?.text ?? "";
    check("前置：bug#1 初始状态为 new", baseText.includes('"status": "new"'), baseText.slice(0, 160));

    // 4. staged 写：合法迁移 bug #1 new → accepted，应返回 pending 提案而非直接生效
    const upd = await request(4, "tools/call", {
      name: "update_ticket_status",
      arguments: { kind: "bug", id: bug1Hash, to_status: "accepted", reason: "冒烟测试：staged 模式提交提案" },
    });
    const updText: string = upd.result?.content?.[0]?.text ?? "";
    const parsed = tryParseProposal(updText);
    const proposalId = parsed?.proposal?.id ?? "";
    check(
      "staged 写返回 pending 提案（p_ 前缀 ID）",
      !upd.result?.isError && updText.includes("pending") && proposalId.startsWith("p_"),
      updText.slice(0, 160),
    );

    // 5. 批准前变更未生效：工单状态仍为 new
    const still = await request(5, "tools/call", { name: "get_ticket", arguments: { kind: "bug", id: bug1Hash } });
    const stillText: string = still.result?.content?.[0]?.text ?? "";
    check("批准前变更未生效（工单仍为 new）", stillText.includes('"status": "new"'), stillText.slice(0, 160));

    // 6. 模拟人工批准：不经过 server，直接写 approved 事件（等价于 npm run proposal -- approve）
    try {
      await new ProposalStore(PROPOSALS_FILE, 30).appendEvent("approved", proposalId, "user:smoke");
      check("模拟人工 CLI 批准提案", true);
    } catch (e) {
      check("模拟人工 CLI 批准提案", false, String(e));
    }

    // 7. 不调用 get_proposal，直接等待 server worker 主动应用；以工单状态作为权威结果验证
    let workerAppliedText = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ticket = await request(70 + attempt, "tools/call", {
        name: "get_ticket",
        arguments: { kind: "bug", id: bug1Hash },
      });
      workerAppliedText = ticket.result?.content?.[0]?.text ?? "";
      if (workerAppliedText.includes('"status": "accepted"')) break;
      await wait(100);
    }
    check(
      "批准后 server worker 主动应用（无需 get_proposal 触发）",
      workerAppliedText.includes('"status": "accepted"'),
      workerAppliedText.slice(0, 200),
    );

    // 8. get_proposal 只查询已落盘终态，不触发写入
    const again = await request(8, "tools/call", { name: "get_proposal", arguments: { id: proposalId } });
    const againText: string = again.result?.content?.[0]?.text ?? "";
    check(
      "get_proposal 纯查询返回 applied",
      !again.result?.isError && againText.includes("applied") && againText.includes("accepted"),
      againText.slice(0, 160),
    );

    // 9. staged 写：非法迁移 bug #2（accepted → verified 不合法），应建提案前快速失败（isError，不产生提案）
    const bad = await request(9, "tools/call", {
      name: "update_ticket_status",
      arguments: { kind: "bug", id: encodeId(2, "bug"), to_status: "verified", reason: "冒烟测试：应建提案前被拒绝" },
    });
    check("非法迁移在建提案前被拒绝", bad.result?.isError === true, JSON.stringify(bad.result).slice(0, 160));

    // 10. get_proposal：未知提案 ID 得到友好错误
    const unknown = await request(10, "tools/call", { name: "get_proposal", arguments: { id: "p_nope" } });
    const unknownText: string = unknown.result?.content?.[0]?.text ?? "";
    check("未知提案 ID 得到友好错误", unknown.result?.isError === true && unknownText.includes("不存在"), unknownText.slice(0, 160));
  } catch (e) {
    failures.push(String(e));
    console.error("✗ 异常:", e);
  } finally {
    child.kill();
  }

  if (stderrBuf.includes("已连接")) check("服务端日志走 stderr（不污染协议通道）", true);
  else console.log("ℹ 未捕获服务端 stderr 启动日志（不判定失败）");

  console.log(failures.length === 0 ? "\nSMOKE STAGED PASS" : `\nSMOKE STAGED FAIL（${failures.length} 项）`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
