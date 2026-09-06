import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlProposalPort } from "./proposals.js";
import { GatewayError } from "./sessions.js";

function fixture(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return {
    event: "created" as const,
    ts: "2026-08-31T10:00:00.000Z",
    actor: "agent",
    proposal: {
      id: "p_1",
      sessionId: "s_1",
      orgId: 7,
      tool: "update_ticket_status",
      kind: "bug",
      subjectHashId: "bug_hash_1",
      subjectId: 42,
      fromStatus: "new",
      toStatus: "accepted",
      reason: "已复现并确认进入处理",
      expiresAt,
    },
  };
}

function setup(expiresAt?: string) {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-proposals-"));
  const file = join(dir, "proposals.jsonl");
  writeFileSync(file, `${JSON.stringify(fixture(expiresAt))}\n`, "utf8");
  const port = new JsonlProposalPort(file);
  return {
    file,
    port,
    close: async () => {
      await port.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("JSONL proposal：按 sid/org 隔离且不外发内部 subjectId", async () => {
  const ctx = setup();
  try {
    const own = await ctx.port.listForSession("s_1", 7);
    assert.equal(own.length, 1);
    assert.equal(own[0].proposal.status, "pending");
    assert.equal("subjectId" in (own[0].proposal as unknown as Record<string, unknown>), false);
    assert.deepEqual(await ctx.port.listForSession("s_other", 7), []);
    assert.deepEqual(await ctx.port.listForSession("s_1", 8), []);
  } finally {
    await ctx.close();
  }
});

test("JSONL proposal：跨组织/跨会话决定统一返回 404，避免枚举", async () => {
  const ctx = setup();
  try {
    for (const patch of [
      { sessionId: "s_other", orgId: 7 },
      { sessionId: "s_1", orgId: 8 },
    ]) {
      await assert.rejects(
        () =>
          ctx.port.decide({
            ...patch,
            proposalId: "p_1",
            decision: "approve",
            actor: "user:9",
          }),
        (error: unknown) => error instanceof GatewayError && error.status === 404,
      );
    }
  } finally {
    await ctx.close();
  }
});

test("JSONL proposal：重复批准幂等，只追加一次 approved", async () => {
  const ctx = setup();
  try {
    const input = {
      sessionId: "s_1",
      orgId: 7,
      proposalId: "p_1",
      decision: "approve" as const,
      actor: "user:9",
    };
    const [first, second] = await Promise.all([ctx.port.decide(input), ctx.port.decide(input)]);
    assert.equal(first.proposal.status, "approved");
    assert.equal(second.proposal.status, "approved");
    const events = readFileSync(ctx.file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string });
    assert.equal(events.filter((event) => event.event === "approved").length, 1);
    assert.equal(events.some((event) => event.event === "applied"), false, "Gateway 只批准，不得冒充 MCP worker 应用域写");
  } finally {
    await ctx.close();
  }
});

test("JSONL proposal：拒绝不产生 applied，重复拒绝幂等", async () => {
  const ctx = setup();
  try {
    const input = {
      sessionId: "s_1",
      orgId: 7,
      proposalId: "p_1",
      decision: "reject" as const,
      actor: "user:9",
      note: "风险信息不足",
    };
    await ctx.port.decide(input);
    await ctx.port.decide(input);
    const events = readFileSync(ctx.file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string });
    assert.equal(events.filter((event) => event.event === "rejected").length, 1);
    assert.equal(events.some((event) => event.event === "applied"), false);
  } finally {
    await ctx.close();
  }
});

test("JSONL proposal：过期自动留痕并 fail-closed 拒绝批准", async () => {
  const ctx = setup(new Date(Date.now() - 60_000).toISOString());
  try {
    const listed = await ctx.port.listForSession("s_1", 7);
    assert.equal(listed[0].proposal.status, "expired");
    await assert.rejects(
      () =>
        ctx.port.decide({
          sessionId: "s_1",
          orgId: 7,
          proposalId: "p_1",
          decision: "approve",
          actor: "user:9",
        }),
      (error: unknown) => error instanceof GatewayError && error.status === 409,
    );
    const events = readFileSync(ctx.file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string });
    assert.equal(events.filter((event) => event.event === "expired").length, 1);
  } finally {
    await ctx.close();
  }
});
