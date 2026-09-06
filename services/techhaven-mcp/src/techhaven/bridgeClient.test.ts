import assert from "node:assert/strict";
import test from "node:test";
import type { TicketRecord } from "../domain/types.js";
import { DomainError } from "./client.js";
import { BridgeTechHavenClient } from "./bridgeClient.js";

const TICKET: TicketRecord = {
  id: 1,
  kind: "bug",
  orgId: 7,
  title: "白屏",
  description: "",
  status: "new",
  priority: "high",
  assignee: "",
  creator: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("Bridge client 注入内部 token、session 和 org，不携带旧后端凭据", async () => {
  let request: { url: string; headers: Headers } | undefined;
  const client = new BridgeTechHavenClient({
    bridgeUrl: "http://bridge.test/",
    bridgeToken: "bridge-secret",
    sessionId: "s_7",
    orgId: 7,
    fetchImpl: async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers) };
      return Response.json({ ticket: TICKET });
    },
  });

  const ticket = await client.getTicket(7, "bug", 1);

  assert.equal(ticket?.title, "白屏");
  assert.equal(request?.url, "http://bridge.test/internal/v1/tickets/bug/1");
  assert.equal(request?.headers.get("authorization"), "Bearer bridge-secret");
  assert.equal(request?.headers.get("x-techhaven-session"), "s_7");
  assert.equal(request?.headers.get("x-techhaven-org"), "7");
});

test("Bridge client 在本地拒绝跨组织调用", async () => {
  const client = new BridgeTechHavenClient({
    bridgeUrl: "http://bridge.test",
    bridgeToken: "bridge-secret",
    sessionId: "s_7",
    orgId: 7,
    fetchImpl: async () => {
      throw new Error("不应发请求");
    },
  });

  await assert.rejects(
    () => client.getTicket(8, "bug", 1),
    (error: unknown) => error instanceof DomainError && error.code === "ORG_MISMATCH",
  );
});

test("状态更新把 proposal id 作为幂等键并携带写前状态", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BridgeTechHavenClient({
    bridgeUrl: "http://bridge.test",
    bridgeToken: "bridge-secret",
    sessionId: "s_7",
    orgId: 7,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return Response.json({ ticket: TICKET });
      return Response.json({ ticket: { ...TICKET, status: "accepted" }, operation: { status: "confirmed" } });
    },
  });

  const updated = await client.updateTicketStatus(7, "bug", 1, "accepted", "确认问题已经复现", {
    idempotencyKey: "p_1",
    expectedFromStatus: "new",
  });

  assert.equal(updated.status, "accepted");
  assert.equal(new Headers(requests[1]?.init?.headers).get("idempotency-key"), "p_1");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    toStatus: "accepted",
    reason: "确认问题已经复现",
    expectedFromStatus: "new",
  });
});
