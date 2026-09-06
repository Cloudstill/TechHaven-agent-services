import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError, BridgeService } from "./bridgeService.js";
import { LegacyBackendError } from "./legacyClient.js";
import { JsonlOperationLedger } from "./ledger.js";
import type { LegacyBackendPort, TicketKind, TicketPage, TicketRecord, TrendSummary } from "./types.js";

class FakeLegacy implements LegacyBackendPort {
  status = "new";
  updates = 0;
  updateBehavior: "ok" | "commit-then-throw" | "throw" = "ok";

  ticket(orgId = 1): TicketRecord {
    return {
      id: 1,
      kind: "bug",
      orgId,
      title: "白屏",
      description: "",
      status: this.status,
      priority: "high",
      assignee: "",
      creator: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  async getTicket(orgId: number): Promise<TicketRecord | null> {
    return this.ticket(orgId);
  }
  async listTickets(): Promise<TicketPage> {
    return { total: 1, page: 1, pageSize: 20, items: [this.ticket()] };
  }
  async searchRequirements(): Promise<TicketPage> {
    return { total: 0, page: 1, pageSize: 20, items: [] };
  }
  async getTrendSummary(orgId: number, days: number): Promise<TrendSummary> {
    return {
      orgId,
      days,
      byKind: {
        requirement: { open: 0, closed: 0, total: 0 },
        bug: { open: 1, closed: 0, total: 1 },
        task: { open: 0, closed: 0, total: 0 },
      },
      newlyCreated: 0,
      newlyClosed: 0,
    };
  }
  async updateTicketStatus(_orgId: number, _kind: TicketKind, _id: number, toStatus: string): Promise<void> {
    this.updates += 1;
    if (this.updateBehavior === "throw") {
      throw new LegacyBackendError("LEGACY_UNAVAILABLE", "网络断开", 502, true);
    }
    this.status = toStatus;
    if (this.updateBehavior === "commit-then-throw") {
      throw new LegacyBackendError("LEGACY_UNAVAILABLE", "响应丢失", 502, true);
    }
  }
}

function input(reason = "确认问题已经复现") {
  return {
    sessionId: "s_1",
    orgId: 1,
    kind: "bug" as const,
    id: 1,
    toStatus: "accepted",
    reason,
    expectedFromStatus: "new",
    idempotencyKey: "p_1",
  };
}

test("并发重复请求只写旧后端一次，并返回幂等重放", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new FakeLegacy();
  const service = new BridgeService(legacy, new JsonlOperationLedger(join(dir, "operations.jsonl")));

  const [first, replay] = await Promise.all([service.transition(input()), service.transition(input())]);

  assert.equal(legacy.updates, 1);
  assert.equal(first.ticket.status, "accepted");
  assert.equal(replay.operation.replayed, true);
});

test("同一幂等键不能用于不同请求", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new BridgeService(new FakeLegacy(), new JsonlOperationLedger(join(dir, "operations.jsonl")));
  await service.transition(input());
  await assert.rejects(
    () => service.transition(input("另一个完全不同的原因")),
    (error: unknown) => error instanceof BridgeError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => service.transition({ ...input(), sessionId: "s_other" }),
    (error: unknown) => error instanceof BridgeError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("旧后端提交后响应丢失时通过读后端完成对账", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new FakeLegacy();
  legacy.updateBehavior = "commit-then-throw";
  const service = new BridgeService(legacy, new JsonlOperationLedger(join(dir, "operations.jsonl")));

  const result = await service.transition(input());

  assert.equal(result.operation.reconciled, true);
  assert.equal(result.ticket.status, "accepted");
});

test("无法确认的写入进入 uncertain，重复调用不会盲目重试", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new FakeLegacy();
  legacy.updateBehavior = "throw";
  const service = new BridgeService(legacy, new JsonlOperationLedger(join(dir, "operations.jsonl")));

  await assert.rejects(() => service.transition(input()), /网络断开/);
  await assert.rejects(
    () => service.transition(input()),
    (error: unknown) => error instanceof BridgeError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(legacy.updates, 1);
});

// 审查意见 F5：两个不同 idempotencyKey 的提案改同一工单（同一 (orgId, kind, id)），
// 旧按 idempotencyKey 排队时它们会并发读—校验—写，第二个覆盖第一个。
// 修复后按 subjectKey 串行：第二个读到第一个写入后的新状态，
// 必然因 expectedFromStatus 不匹配触发 STALE_PRECONDITION。
test("F5 · 同工单两个不同提案串行：第二个必读到第一个的新状态并拒写", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new FakeLegacy();
  // 工单起步状态：processing —— 两个不同提案都合理地从这里出发
  legacy.status = "processing";
  const service = new BridgeService(legacy, new JsonlOperationLedger(join(dir, "operations.jsonl")));

  // 提案 A：processing → verified（写入完成会把状态推到 verified）
  const proposalVerified = { ...input(), toStatus: "verified", expectedFromStatus: "processing", idempotencyKey: "p_A" };
  // 提案 B：processing → reopened（不同 idempotencyKey 同工单）
  const proposalReopened = { ...input(), toStatus: "reopened", expectedFromStatus: "processing", idempotencyKey: "p_B" };

  const first = await service.transition(proposalVerified);
  assert.equal(first.ticket.status, "verified");
  assert.equal(legacy.updates, 1);

  await assert.rejects(
    () => service.transition(proposalReopened),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "STALE_PRECONDITION",
    "B 应读到 verified，与期望的 processing 不一致 → STALE_PRECONDITION",
  );

  // B 被拒，不再继续写旧后端；A 的 verified 落库仍然只有一次
  assert.equal(legacy.updates, 1);
  // 共享 ledger 仅记录 A 的 confirmed，B 因前置拒绝未落 started
  // 共享 ledger 中 p_A 已 confirmed，p_B 不存在
  const ledger = new JsonlOperationLedger(join(dir, "operations.jsonl"));
  assert.ok(ledger.get("p_A"), "ledger 应有 A 的 confirmed 记录");
  assert.equal(ledger.get("p_A")?.status, "confirmed");
  assert.equal(ledger.get("p_B"), undefined, "B 被拒，ledger 不应记录");
});

// 审查意见 F5 收尾校验：哪怕两个提案从不同起始状态出发，subjectKey 串行也要保证
// 第二个必然用第一个写入后的最新工单状态做判定，避免「读后别人改了再写」。
test("F5 · 后到的提案用最新工单状态做 expectedFromStatus 校验", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new FakeLegacy();
  legacy.status = "new";
  const service = new BridgeService(legacy, new JsonlOperationLedger(join(dir, "operations.jsonl")));

  const a = { ...input(), toStatus: "accepted", expectedFromStatus: "new", idempotencyKey: "p_seqA" };
  const b = { ...input(), toStatus: "verified", expectedFromStatus: "new", idempotencyKey: "p_seqB" };

  await service.transition(a);
  // legacy.status 现在是 accepted，B 的 expectedFromStatus="new" 必失败
  await assert.rejects(
    () => service.transition(b),
    (error: unknown) => error instanceof BridgeError && error.code === "STALE_PRECONDITION",
  );
  assert.equal(legacy.updates, 1);
});
