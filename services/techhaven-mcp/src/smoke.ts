/**
 * P0 端到端冒烟测试：以客户端身份通过 stdio 驱动真实 server 进程，
 * 走完整 MCP 握手 + 工具调用，验证工具流闭环（TH-RFC-001 P0 验收）。
 *
 *   npm run smoke
 */
import { spawn } from "node:child_process";
import { signAgentToken } from "./auth/agentToken.js";
import { encodeId } from "./hashid.js";

const SECRET = "smoke-secret";
const PROTOCOL = "2025-06-18";

interface JsonRpcResp {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = signAgentToken(
    { v: 1, sid: "smoke-1", org: 1, scopes: ["rd:read", "rd:write"], iat: now, exp: now + 3600 },
    SECRET,
  );

  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:")], {
    env: {
      ...process.env,
      TECHHAVEN_AGENT_TOKEN: token,
      TECHHAVEN_TOKEN_SECRET: SECRET,
      TECHHAVEN_BACKEND: "mock",
      TECHHAVEN_AUDIT_FILE: "./audit/smoke-audit.jsonl",
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
      clientInfo: { name: "smoke", version: "0.0.0" },
    });
    check("initialize 握手", init.result?.serverInfo?.name === "techhaven-mcp", JSON.stringify(init));
    notify("notifications/initialized");

    // 2. 工具清单
    const list = await request(2, "tools/list", {});
    const names: string[] = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
    const expected = ["get_ticket", "list_my_tickets", "search_requirements", "get_trend_summary", "update_ticket_status"];
    check("tools/list 含全部 P0 工具", expected.every((n) => names.includes(n)), names.join(","));

    // 3. 读：get_ticket（bug #1 的 hashId）
    const bug1Hash = encodeId(1, "bug");
    const got = await request(3, "tools/call", { name: "get_ticket", arguments: { kind: "bug", id: bug1Hash } });
    const gotText: string = got.result?.content?.[0]?.text ?? "";
    check("get_ticket 读到 mock 缺陷", gotText.includes("KaTeX"), gotText.slice(0, 120));

    // 4. 读：list_my_tickets
    const listed = await request(4, "tools/call", { name: "list_my_tickets", arguments: { kind: "task" } });
    const listText: string = listed.result?.content?.[0]?.text ?? "";
    check("list_my_tickets 返回任务列表", listText.includes("Vite"), listText.slice(0, 120));

    // 5. 写：合法迁移 bug #1 new → accepted
    const upd = await request(5, "tools/call", {
      name: "update_ticket_status",
      arguments: { kind: "bug", id: bug1Hash, to_status: "accepted", reason: "冒烟测试：确认复现，接受进入处理" },
    });
    const updText: string = upd.result?.content?.[0]?.text ?? "";
    check("合法状态迁移成功", !upd.result?.isError && updText.includes("accepted"), updText.slice(0, 160));

    // 6. 写：非法迁移 bug #2 new → verified（应被状态机拒绝）
    const bad = await request(6, "tools/call", {
      name: "update_ticket_status",
      arguments: { kind: "bug", id: encodeId(2, "bug"), to_status: "verified", reason: "冒烟测试：应被拒绝" },
    });
    check("非法状态迁移被拒绝", bad.result?.isError === true, JSON.stringify(bad.result).slice(0, 160));

    // 7. hashId 防伪造：乱造 ID 应得到友好错误而非崩溃
    const forged = await request(7, "tools/call", { name: "get_ticket", arguments: { kind: "bug", id: "NOT_A_HASH" } });
    check("伪造 hashId 得到友好错误", forged.result?.isError === true, JSON.stringify(forged.result).slice(0, 160));

    // 8. 语义层读取：get_semantics 返回缺陷的字段业务含义
    const sem = await request(8, "tools/call", { name: "get_semantics", arguments: { kind: "bug" } });
    const semText: string = sem.result?.content?.[0]?.text ?? "";
    check("get_semantics 返回语义层描述", semText.includes("缺陷"), semText.slice(0, 160));
  } catch (e) {
    failures.push(String(e));
    console.error("✗ 异常:", e);
  } finally {
    child.kill();
  }

  if (stderrBuf.includes("已连接")) check("服务端日志走 stderr（不污染协议通道）", true);
  else console.log("ℹ 未捕获服务端 stderr 启动日志（不判定失败）");

  console.log(failures.length === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL（${failures.length} 项）`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
