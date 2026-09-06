/**
 * P1 端到端冒烟：spawn dist/index.js（mock 驱动），走 HTTP + SSE 全闭环，
 * 验证鉴权 / 会话创建 / 事件桥 / 断线与进程重启回放 / 权限中继 / 取消 / 终态 / 配额 / 审计 JSONL（TH-RFC-001 §05.1）。
 *
 *   npm run smoke    （先 build，再以客户端身份驱动真实网关进程）
 *
 * 脚手架 ≈ services/techhaven-mcp/src/smoke.ts 同构孪生（防漂移：改动需同步评审两处）
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "./types.js";

const PORT = 3097;
const TOKEN = "smoke-token";
const BASE = `http://127.0.0.1:${PORT}`;
const SMOKE_DATA_DIR = "data-smoke";
const PROPOSALS_FILE = `./${SMOKE_DATA_DIR}/proposals.jsonl`;
/** 包根目录（dist / data-smoke 都挂在这里，与子进程 cwd 保持一致） */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "x-techhaven-actor": "user:9" };
}

/** 普通 JSON API 调用（勿用于 SSE；401 用例走裸 fetch） */
async function api(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...opts.headers,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // 空响应体 / 非 JSON（如 401 文本），置 null 即可
  }
  return { status: res.status, json };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${label}（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 等网关进程监听就绪 */
async function waitReady(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`, { headers: authHeaders() });
      if (res.ok) return true;
    } catch {
      // 尚未监听，继续等
    }
    await sleep(100);
  }
  return false;
}

interface SseItem {
  event?: EventEnvelope;
  end?: boolean;
}

/**
 * SSE 读取器：手写解析（id: / event: / data: / 注释行 / 空行分帧）。
 * 用手动 iterator 而非 for-await：中途暂停后还要继续读，for-await 的 break 会关闭流。
 */
class SseReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private lineBuf = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];

  constructor(res: Response) {
    const body = res.body as unknown as AsyncIterable<Uint8Array> | null;
    if (!body) throw new Error("SSE 响应无 body（连接可能被提前关闭）");
    this.iterator = body[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    // 流被 async iterator 锁定，必须走迭代器 return 协议释放；直接 body.cancel() 会 ERR_INVALID_STATE
    try {
      await this.iterator.return?.();
    } catch {
      // 连接可能已关闭
    }
  }

  async next(): Promise<SseItem> {
    while (true) {
      const idx = this.lineBuf.indexOf("\n");
      if (idx >= 0) {
        const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
        this.lineBuf = this.lineBuf.slice(idx + 1);
        if (line.startsWith(":")) continue; // keepalive 注释行
        if (line.startsWith("event:")) {
          this.eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          this.dataLines.push(line.slice(5).trim());
          continue;
        }
        if (line === "") {
          // 空行 = 一帧结束
          const name = this.eventName;
          const payload = this.dataLines.join("\n");
          this.eventName = null;
          this.dataLines = [];
          if (name === "end") return { end: true };
          if (payload) return { event: JSON.parse(payload) as EventEnvelope };
        }
        continue; // 其余行（如 id:）忽略
      }
      const chunk = await this.iterator.next();
      if (chunk.done) return { end: true };
      this.lineBuf += Buffer.from(chunk.value).toString("utf8");
    }
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail?: string): void => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` —— ${detail ?? ""}`}`);
    if (!cond) failures.push(name);
  };

  const spawnGateway = () =>
    spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        TECHHAVEN_GATEWAY_TOKEN: TOKEN,
        TECHHAVEN_GATEWAY_PORT: String(PORT),
        TECHHAVEN_ENGINE_DRIVER: "mock",
        TECHHAVEN_GATEWAY_DATA_DIR: `./${SMOKE_DATA_DIR}`,
        TECHHAVEN_PROPOSALS_FILE: PROPOSALS_FILE,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
  const stopGateway = async (processToStop: ReturnType<typeof spawn>): Promise<void> => {
    if (processToStop.exitCode !== null) return;
    processToStop.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      processToStop.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  let child = spawnGateway();
  let stderr = "";
  const captureStderr = (): void => {
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
  };
  captureStderr();

  let sseRes: Response | undefined;
  let sse: SseReader | undefined;

  try {
    // 0. 服务就绪
    if (!(await waitReady())) {
      throw new Error(`网关未在预期时间内就绪\n---- gateway stderr ----\n${stderr.slice(-2000)}`);
    }
    check("网关进程就绪", true);

    // 1. 健康检查免鉴权（探活不携带凭据）；业务接口无 token → 401
    const noToken = await fetch(`${BASE}/healthz`);
    check("无 token 访问 /healthz → 200（健康检查免鉴权）", noToken.status === 200, `收到 ${noToken.status}`);
    const health = await api("GET", "/healthz");
    check(
      "带 token 访问 /healthz → 200 且 driver=mock",
      health.status === 200 && health.json?.ok === true && health.json?.driver === "mock",
      JSON.stringify(health.json),
    );

    // 2. 创建会话
    const created = await api("POST", "/v1/sessions", {
      body: { orgId: 1, subjectType: "bug", subjectId: "bug_1", prompt: "读取缺陷并修复" },
    });
    check(
      "POST /v1/sessions → 201 且返回 sid",
      created.status === 201 && typeof created.json?.sid === "string",
      JSON.stringify(created.json),
    );
    const sid = created.json.sid as string;

    // 2.1 MCP proposal JSONL → Gateway 查询/可信 actor 审批 → 生命周期并入同一 SSE。
    const proposalId = `p_smoke_${Date.now().toString(36)}`;
    appendFileSync(
      join(ROOT, SMOKE_DATA_DIR, "proposals.jsonl"),
      `${JSON.stringify({
        event: "created",
        ts: new Date().toISOString(),
        actor: "agent",
        proposal: {
          id: proposalId,
          sessionId: sid,
          orgId: 1,
          tool: "update_ticket_status",
          kind: "bug",
          subjectHashId: "bug_1",
          subjectId: 1,
          fromStatus: "new",
          toStatus: "accepted",
          reason: "smoke proposal",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })}\n`,
      "utf8",
    );
    const proposalList = await api("GET", `/v1/sessions/${sid}/proposals`);
    check(
      "GET session proposals → pending 且不外发内部 subjectId",
      proposalList.status === 200 &&
        proposalList.json?.proposals?.[0]?.status === "pending" &&
        !("subjectId" in proposalList.json.proposals[0]),
      JSON.stringify(proposalList.json),
    );
    const missingActor = await api("POST", `/v1/sessions/${sid}/proposals/${proposalId}/decision`, {
      headers: { "x-techhaven-actor": "" },
      body: { decision: "approve" },
    });
    check("proposal decision 缺可信 actor → 401", missingActor.status === 401, JSON.stringify(missingActor.json));
    const proposalApproved = await api("POST", `/v1/sessions/${sid}/proposals/${proposalId}/decision`, {
      headers: { "x-techhaven-actor": "user:9" },
      body: { decision: "approve" },
    });
    check("proposal approve → 200 approved", proposalApproved.status === 200 && proposalApproved.json?.status === "approved");
    const proposalApprovedAgain = await api("POST", `/v1/sessions/${sid}/proposals/${proposalId}/decision`, {
      headers: { "x-techhaven-actor": "user:9" },
      body: { decision: "approve" },
    });
    check(
      "proposal 重复 approve 幂等",
      proposalApprovedAgain.status === 200 && proposalApprovedAgain.json?.status === "approved",
      JSON.stringify(proposalApprovedAgain.json),
    );

    // 3. SSE：读到 permission_request（顺带断言见到 assistant_chunk / tool_call get_ticket）
    sseRes = await fetch(`${BASE}/v1/sessions/${sid}/events`, { headers: authHeaders() });
    check(
      "SSE 响应 content-type 为 text/event-stream",
      (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"),
      sseRes.headers.get("content-type") ?? "无",
    );
    let reader = new SseReader(sseRes);
    sse = reader;
    const seen: EventEnvelope[] = [];
    let permRequestId: string | undefined;
    while (!permRequestId) {
      const item = await withTimeout(reader.next(), 15_000, "等待 permission_request");
      if (item.end) break;
      if (!item.event) continue;
      seen.push(item.event);
      if (item.event.type === "permission_request") permRequestId = item.event.payload.requestId;
    }
    check(
      "SSE 见到 assistant_chunk",
      seen.some((e) => e.type === "assistant_chunk"),
      JSON.stringify(seen.map((e) => e.type)),
    );
    check(
      "SSE 见到 tool_call mcp__techhaven__get_ticket",
      seen.some((e) => e.type === "tool_call" && e.payload.tool === "mcp__techhaven__get_ticket"),
      JSON.stringify(seen.map((e) => e.type)),
    );
    check("SSE 收到 permission_request", permRequestId !== undefined, JSON.stringify(seen.map((e) => e.type)));
    check(
      "SSE 收到产品 proposal 生命周期且与 runner permission 区分",
      seen.some((event) => event.type === "proposal_lifecycle" && event.payload.proposal.id === proposalId) &&
        seen.some((event) => event.type === "permission_request"),
      JSON.stringify(seen.map((event) => event.type)),
    );

    // 4. 主动断开观察连接；断线期间审批让会话继续，随后 after=<lastSeq> 回放缺失尾部
    const resumeAfter = Math.max(...seen.map((event) => event.seq));
    await reader.close();
    const approved = await api("POST", `/v1/sessions/${sid}/permission`, {
      body: { requestId: permRequestId ?? "", decision: "approve" },
    });
    check("POST permission approve → 200 ok", approved.status === 200 && approved.json?.ok === true, JSON.stringify(approved.json));
    sseRes = await fetch(`${BASE}/v1/sessions/${sid}/events?after=${resumeAfter}`, { headers: authHeaders() });
    reader = new SseReader(sseRes);
    sse = reader;
    let succeeded = false;
    let streamEnded = false;
    const resumed: EventEnvelope[] = [];
    while (!succeeded && !streamEnded) {
      const item = await withTimeout(reader.next(), 15_000, "等待 succeeded");
      if (item.end) {
        streamEnded = true;
        break;
      }
      if (item.event) {
        resumed.push(item.event);
        if (item.event.type === "status_change" && item.event.payload.status === "succeeded") succeeded = true;
      }
    }
    const resumedSeqs = resumed.map((event) => event.seq);
    check(
      "SSE after 续传只回放断点后的事件",
      resumedSeqs.length > 0 && resumedSeqs.every((seq) => seq > resumeAfter),
      JSON.stringify({ resumeAfter, resumedSeqs }),
    );
    check("SSE 续传事件无重复 seq", new Set(resumedSeqs).size === resumedSeqs.length, JSON.stringify(resumedSeqs));
    check(
      "SSE 续传事件 seq 连续无缺口",
      resumedSeqs.every((seq, index) => seq === resumeAfter + index + 1),
      JSON.stringify({ resumeAfter, resumedSeqs }),
    );
    check("approve 后收到 status_change succeeded", succeeded);
    const tail = streamEnded ? { end: true } : await withTimeout(reader.next(), 15_000, "等待 event: end");
    check("终态后 SSE 以 event: end 关闭", tail.end === true, JSON.stringify(tail));

    // 5. 会话详情：终态已落
    const detail = await api("GET", `/v1/sessions/${sid}`);
    check(
      "GET /v1/sessions/:sid → status=succeeded",
      detail.status === 200 && detail.json?.status === "succeeded",
      JSON.stringify(detail.json),
    );

    // 6. 重启恢复：终态历史应可查询/完整回放；被中断的运行态会话明确收敛为 failed
    const interruptedCreated = await api("POST", "/v1/sessions", {
      body: { orgId: 4, prompt: "重启中断恢复验证" },
    });
    const interruptedSid = interruptedCreated.json?.sid as string;
    const interruptedRes = await fetch(`${BASE}/v1/sessions/${interruptedSid}/events`, { headers: authHeaders() });
    const interruptedReader = new SseReader(interruptedRes);
    let interruptedLastSeq = 0;
    let interruptedAtPermission = false;
    while (!interruptedAtPermission) {
      const item = await withTimeout(interruptedReader.next(), 15_000, "等待重启中断会话到达审批点");
      if (item.end) break;
      if (!item.event) continue;
      interruptedLastSeq = item.event.seq;
      interruptedAtPermission = item.event.type === "permission_request";
    }
    await interruptedReader.close();
    check("重启前运行态会话到达 awaiting_permission", interruptedAtPermission && interruptedLastSeq > 0);

    await stopGateway(child);
    stderr = "";
    child = spawnGateway();
    captureStderr();
    if (!(await waitReady())) throw new Error(`网关重启后未就绪\n${stderr.slice(-2000)}`);
    check("Gateway 使用同一 JSONL 目录重启成功", true);

    const recoveredDetail = await api("GET", `/v1/sessions/${sid}`);
    check(
      "重启后终态会话仍可查询",
      recoveredDetail.status === 200 && recoveredDetail.json?.status === "succeeded",
      JSON.stringify(recoveredDetail.json),
    );
    const recoveredRes = await fetch(`${BASE}/v1/sessions/${sid}/events`, { headers: authHeaders() });
    const recoveredReader = new SseReader(recoveredRes);
    const recoveredEvents: EventEnvelope[] = [];
    for (;;) {
      const item = await withTimeout(recoveredReader.next(), 15_000, "等待重启后历史回放结束");
      if (item.end) break;
      if (item.event) recoveredEvents.push(item.event);
    }
    const recoveredSeqs = recoveredEvents.map((event) => event.seq);
    const expectedSeqs = [...seen, ...resumed].map((event) => event.seq);
    check(
      "重启后 SSE 完整回放历史且无重复",
      JSON.stringify(recoveredSeqs) === JSON.stringify(expectedSeqs),
      JSON.stringify({ recoveredSeqs, expectedSeqs }),
    );
    check(
      "重启后 proposal 生命周期也进入权威事件回放",
      recoveredEvents.some((event) => event.type === "proposal_lifecycle" && event.payload.proposal.id === proposalId),
      JSON.stringify(recoveredEvents.map((event) => event.type)),
    );

    const interruptedDetail = await api("GET", `/v1/sessions/${interruptedSid}`);
    check(
      "重启后被中断会话收敛为 failed",
      interruptedDetail.status === 200 && interruptedDetail.json?.status === "failed",
      JSON.stringify(interruptedDetail.json),
    );
    const interruptedTailRes = await fetch(`${BASE}/v1/sessions/${interruptedSid}/events?after=${interruptedLastSeq}`, {
      headers: authHeaders(),
    });
    const interruptedTailReader = new SseReader(interruptedTailRes);
    const interruptedTail = await withTimeout(interruptedTailReader.next(), 15_000, "等待重启 failed 终态事件");
    check(
      "重启后中断会话续传唯一 failed 终态",
      interruptedTail.event?.type === "status_change" &&
        interruptedTail.event.seq === interruptedLastSeq + 1 &&
        interruptedTail.event.payload.status === "failed",
      JSON.stringify(interruptedTail),
    );
    const interruptedEnd = await withTimeout(interruptedTailReader.next(), 15_000, "等待重启 failed 流结束");
    check("重启后中断会话 SSE 正常 end", interruptedEnd.end === true, JSON.stringify(interruptedEnd));

    // 7. 取消闭环：API 幂等成功，SSE 收到 cancelled，详情同步终态
    const cancelCreated = await api("POST", "/v1/sessions", {
      body: { orgId: 3, prompt: "取消闭环验证" },
    });
    const cancelSid = cancelCreated.json?.sid as string;
    const cancelRes = await fetch(`${BASE}/v1/sessions/${cancelSid}/events`, { headers: authHeaders() });
    const cancelReader = new SseReader(cancelRes);
    sse = cancelReader;
    const cancelled = await api("POST", `/v1/sessions/${cancelSid}/cancel`);
    check("POST cancel → 200 ok", cancelled.status === 200 && cancelled.json?.ok === true, JSON.stringify(cancelled.json));
    let sawCancelled = false;
    let cancelEnded = false;
    while (!cancelEnded) {
      const item = await withTimeout(cancelReader.next(), 15_000, "等待 cancelled / end");
      if (item.end) {
        cancelEnded = true;
        break;
      }
      if (item.event?.type === "status_change" && item.event.payload.status === "cancelled") sawCancelled = true;
    }
    check("cancel 后 SSE 收到 status_change cancelled", sawCancelled);
    const cancelDetail = await api("GET", `/v1/sessions/${cancelSid}`);
    check("cancel 后会话详情 status=cancelled", cancelDetail.json?.status === "cancelled", JSON.stringify(cancelDetail.json));

    // 8. 配额：org2 连开 3 个（默认 maxSessionsPerOrg=3）→ 第 4 个 → 429
    const placeholders: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await api("POST", "/v1/sessions", { body: { orgId: 2, prompt: `配额占位会话 #${i + 1}` } });
      if (r.status === 201 && typeof r.json?.sid === "string") placeholders.push(r.json.sid);
    }
    check("org2 连开 3 个会话成功", placeholders.length === 3, `实际 ${placeholders.length}`);
    const over = await api("POST", "/v1/sessions", { body: { orgId: 2, prompt: "应被配额拒绝" } });
    check(
      "第 4 个会话 → 429 配额超限",
      over.status === 429 && typeof over.json?.error === "string",
      `收到 ${over.status} ${JSON.stringify(over.json)}`,
    );
    for (const pid of placeholders) {
      const c = await api("POST", `/v1/sessions/${pid}/cancel`);
      check(`取消占位会话 ${pid} → 200`, c.status === 200 && c.json?.ok === true, `收到 ${c.status}`);
    }

    // 9. 401 / 404
    const noAuth = await fetch(`${BASE}/v1/sessions`);
    check("无 token 访问业务接口 → 401", noAuth.status === 401, `收到 ${noAuth.status}`);
    const missing = await api("GET", "/v1/sessions/s_does_not_exist");
    check("未知 sid → 404", missing.status === 404, `收到 ${missing.status}`);

    // 10. 审计 JSONL：存在，含 event 行与 permission 审计行
    const jsonlPath = join(ROOT, SMOKE_DATA_DIR, "gateway.jsonl");
    const jsonl = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : "";
    const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
    check("gateway.jsonl 存在且非空", lines.length > 0, jsonlPath);
    check(
      "JSONL 含本会话 event 行",
      lines.some((l) => l.includes('"kind":"event"') && l.includes(sid)),
    );
    check(
      "JSONL 含 permission 审计行",
      lines.some((l) => l.includes('"kind":"permission"') && (permRequestId ? l.includes(permRequestId) : false)),
    );
  } catch (err) {
    failures.push(String(err));
    console.error("✗ 异常:", err);
    if (stderr) console.error("---- gateway stderr 末尾 ----\n" + stderr.slice(-2000));
  }

  // 收尾：断开 SSE（走迭代器 return 协议释放流锁）、终止网关进程
  await sse?.close();
  await stopGateway(child);

  console.log(failures.length === 0 ? "\nGATEWAY SMOKE PASS" : `\nGATEWAY SMOKE FAIL（${failures.length} 项）`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
