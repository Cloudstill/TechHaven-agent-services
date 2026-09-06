import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig } from "./config.js";
import { LegacyBackendError, LegacyHttpClient } from "./legacyClient.js";

const CONFIG: BridgeConfig = {
  port: 3093,
  bridgeToken: "bridge",
  legacyBaseUrl: "https://legacy.test/api/v1",
  legacyRdPrefix: "/rd",
  legacyAuthMode: "bearer",
  legacyAuthValue: "legacy-token",
  legacyTimeoutMs: 5000,
  ledgerFile: "unused.jsonl",
  statusMap: { bug: { "0": "new", "1": "accepted" } },
};

test("详情请求注入旧后端凭据并把数字状态映射为 canonical", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new LegacyHttpClient(CONFIG, async (input, init) => {
    request = { url: String(input), init };
    return Response.json({
      errno: 0,
      data: { id: 7, title: "白屏", status: 0, create_time: "2026-01-01", update_time: "2026-01-02" },
    });
  });

  const ticket = await client.getTicket(3, "bug", 7);

  assert.equal(request?.url, "https://legacy.test/api/v1/rd/bugs/detail?id=7&org_id=3");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer legacy-token");
  assert.equal(ticket?.status, "new");
  assert.equal(ticket?.orgId, 3);
});

test("状态写入自动反转映射且不发送 Bridge 内部身份", async () => {
  let body: unknown;
  const client = new LegacyHttpClient(CONFIG, async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ errno: 0, data: {} });
  });

  await client.updateTicketStatus(3, "bug", 7, "accepted", "确认复现");

  assert.deepEqual(body, { id: 7, status: 1, org_id: 3, reason: "确认复现" });
});

test("旧后端显式返回其他组织的工单时失败关闭", async () => {
  const client = new LegacyHttpClient(CONFIG, async () =>
    Response.json({ errno: 0, data: { id: 7, org_id: 9, title: "越权数据", status: 0 } }),
  );

  await assert.rejects(
    () => client.getTicket(3, "bug", 7),
    (error: unknown) => error instanceof LegacyBackendError && error.code === "LEGACY_ORG_MISMATCH",
  );
});

test("旧后端 5xx 写错误标记为 ambiguous，业务 errno 不标记", async () => {
  const serverError = new LegacyHttpClient(CONFIG, async () => Response.json({ message: "bad" }, { status: 503 }));
  await assert.rejects(
    () => serverError.updateTicketStatus(1, "bug", 1, "accepted", "确认复现"),
    (error: unknown) => error instanceof LegacyBackendError && error.ambiguous,
  );

  const businessError = new LegacyHttpClient(CONFIG, async () => Response.json({ errno: 1101, msg: "未授权" }));
  await assert.rejects(
    () => businessError.updateTicketStatus(1, "bug", 1, "accepted", "确认复现"),
    (error: unknown) => error instanceof LegacyBackendError && !error.ambiguous && error.code === "LEGACY_ERRNO",
  );
});
