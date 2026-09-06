import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BridgeService } from "./bridgeService.js";
import type { BridgeConfig } from "./config.js";
import { LegacyHttpClient } from "./legacyClient.js";
import { JsonlOperationLedger } from "./ledger.js";
import { createBridgeServer } from "./server.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  let status = 0;
  let edits = 0;
  const legacy = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer legacy-secret") {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith("/api/v1/rd/bugs/detail")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ errno: 0, data: { id: 1, title: "白屏", status, create_time: "2026-01-01" } }));
      return;
    }
    if (req.url === "/api/v1/rd/bugs/edit" && req.method === "POST") {
      edits += 1;
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        status = Number((JSON.parse(raw) as { status: number }).status);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ errno: 0, data: {} }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  const temp = mkdtempSync(join(tmpdir(), "techhaven-bridge-smoke-"));
  let bridge: http.Server | undefined;
  try {
    const legacyPort = await listen(legacy);
    const config: BridgeConfig = {
      port: 0,
      bridgeToken: "bridge-secret-at-least-32-bytes-long",
      legacyBaseUrl: `http://127.0.0.1:${legacyPort}/api/v1`,
      legacyRdPrefix: "/rd",
      legacyAuthMode: "bearer",
      legacyAuthValue: "legacy-secret",
      legacyTimeoutMs: 1000,
      ledgerFile: join(temp, "operations.jsonl"),
      statusMap: { bug: { "0": "new", "1": "accepted" } },
    };
    const ledger = new JsonlOperationLedger(config.ledgerFile);
    bridge = createBridgeServer(config, new BridgeService(new LegacyHttpClient(config), ledger));
    const bridgePort = await listen(bridge);
    const base = `http://127.0.0.1:${bridgePort}`;
    const headers = {
      Authorization: "Bearer bridge-secret-at-least-32-bytes-long",
      "X-TechHaven-Session": "s_smoke",
      "X-TechHaven-Org": "1",
    };
    const checks: Array<[string, boolean]> = [];
    const noAuth = await fetch(`${base}/internal/v1/tickets/bug/1`);
    checks.push(["内部 API 无 token 拒绝", noAuth.status === 401]);

    const detail = await fetch(`${base}/internal/v1/tickets/bug/1`, { headers });
    const detailBody = (await detail.json()) as { ticket?: { status?: string } };
    checks.push(["旧数字状态转换为 canonical", detail.status === 200 && detailBody.ticket?.status === "new"]);

    const transitionHeaders = { ...headers, "content-type": "application/json", "idempotency-key": "p_smoke" };
    const first = await fetch(`${base}/internal/v1/tickets/bug/1/transition`, {
      method: "POST",
      headers: transitionHeaders,
      body: JSON.stringify({ toStatus: "accepted", expectedFromStatus: "new", reason: "确认问题已经复现" }),
    });
    const firstBody = (await first.json()) as { ticket?: { status?: string } };
    checks.push(["Bridge 转换写请求并写后确认", first.status === 200 && firstBody.ticket?.status === "accepted"]);

    const replay = await fetch(`${base}/internal/v1/tickets/bug/1/transition`, {
      method: "POST",
      headers: transitionHeaders,
      body: JSON.stringify({ toStatus: "accepted", expectedFromStatus: "new", reason: "确认问题已经复现" }),
    });
    const replayBody = (await replay.json()) as { operation?: { replayed?: boolean } };
    checks.push(["重复幂等请求不重复写旧后端", replayBody.operation?.replayed === true && edits === 1]);

    for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
    else console.log("\nAGENT BRIDGE SMOKE PASS");
  } finally {
    if (bridge) await close(bridge);
    await close(legacy);
    rmSync(temp, { recursive: true, force: true });
  }
}

void main();
