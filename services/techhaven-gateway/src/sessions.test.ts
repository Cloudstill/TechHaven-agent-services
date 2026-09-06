/**
 * 会话层纯域单测（node:test + tsx，无新增依赖）。
 *
 * 覆盖两处对契约敏感的纯函数，均不需要外部实例：
 *  - toEnvelopeJson：SSE 线上信封（TH-RFC-001 §6 / contracts/index.d.ts 的 EventEnvelope）
 *  - sessionView：客户端可见视图（必须剥掉句柄 / 订阅者 / 事件缓存等运行态）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayError, SessionRegistry, sessionView, toEnvelopeJson, type SessionRecord } from "./sessions.js";
import type { EngineDriver, EngineEvent, EngineRuntimeConfig, ProposalLifecycleEvent } from "./types.js";

function makeRecord(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "s_abc123",
    orgId: 7,
    prompt: "重构 proposal 存储",
    status: "running",
    createdAt: "2026-08-29T00:00:00.000Z",
    events: [],
    subscribers: new Set(),
    ...patch,
  };
}

test("toEnvelopeJson：seq/type/occurredAt 上提，payload 不含重复字段", () => {
  const record = makeRecord();
  const ev: EngineEvent = { type: "assistant_chunk", seq: 3, ts: "2026-08-29T01:02:03.000Z", text: "hello" };

  const envelope = JSON.parse(toEnvelopeJson(record, ev)) as Record<string, unknown>;

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.eventId, "s_abc123:3");
  assert.equal(envelope.sessionId, "s_abc123");
  assert.equal(envelope.orgId, 7);
  assert.equal(envelope.seq, 3);
  assert.equal(envelope.type, "assistant_chunk");
  assert.equal(envelope.occurredAt, "2026-08-29T01:02:03.000Z");
  assert.equal(envelope.traceId, "");

  // payload 只保留事件其余字段：不得重复携带 seq / type / ts
  assert.deepEqual(envelope.payload, { text: "hello" });
});

test("toEnvelopeJson：各事件类型的 payload 形状", () => {
  const record = makeRecord();
  const parse = (ev: EngineEvent): Record<string, unknown> => JSON.parse(toEnvelopeJson(record, ev)) as Record<string, unknown>;

  assert.deepEqual(
    (parse({ type: "tool_call", seq: 1, ts: "t", tool: "rd.ticket.update", argsDigest: "abc" }) as { payload: unknown }).payload,
    {
      tool: "rd.ticket.update",
      argsDigest: "abc",
    },
  );
  assert.deepEqual(
    (parse({ type: "tool_result", seq: 2, ts: "t", tool: "rd.ticket.update", ok: true, summary: "ok" }) as { payload: unknown })
      .payload,
    { tool: "rd.ticket.update", ok: true, summary: "ok" },
  );
  assert.deepEqual(
    (parse({ type: "permission_request", seq: 3, ts: "t", requestId: "r1", tool: "rd.ticket.update" }) as { payload: unknown })
      .payload,
    { requestId: "r1", tool: "rd.ticket.update" },
  );
  const proposal = {
    id: "p_1",
    sessionId: "s_abc123",
    orgId: 7,
    tool: "update_ticket_status",
    subjectType: "bug",
    subjectHashId: "bug_1",
    fromStatus: "new",
    toStatus: "accepted",
    reason: "确认处理",
    status: "pending" as const,
    expiresAt: "2026-08-29T03:00:00.000Z",
    updatedAt: "2026-08-29T02:00:00.000Z",
  };
  assert.deepEqual(
    (
      parse({
        type: "proposal_lifecycle",
        seq: 4,
        ts: proposal.updatedAt,
        event: "created",
        actor: "agent",
        proposal,
      }) as { payload: unknown }
    ).payload,
    { event: "created", actor: "agent", proposal },
  );
  assert.deepEqual((parse({ type: "status_change", seq: 4, ts: "t", status: "succeeded" }) as { payload: unknown }).payload, {
    status: "succeeded",
  });
  assert.deepEqual((parse({ type: "error", seq: 5, ts: "t", message: "boom" }) as { payload: unknown }).payload, { message: "boom" });
});

test("SessionRegistry：driver 与 proposal 并发事件由 Gateway 统一连续编号", async () => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-session-proposal-"));
  let firstSeenResolve!: () => void;
  let secondRelease!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    firstSeenResolve = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    secondRelease = resolve;
  });
  const driver: EngineDriver = {
    name: "sequencing-test",
    async startSession() {
      return {
        async *events() {
          yield { type: "status_change" as const, seq: 41, ts: "2026-08-31T01:00:00.000Z", status: "running" as const };
          firstSeenResolve();
          await secondGate;
          yield { type: "status_change" as const, seq: 99, ts: "2026-08-31T01:00:02.000Z", status: "succeeded" as const };
        },
        async send() {},
        async answerPermission() {},
        async cancel() {},
        async dispose() {},
      };
    },
    async dispose() {},
  };
  const registry = await SessionRegistry.open(driver, {
    dataDir: dir,
    maxSessionsPerOrg: 3,
    sessionRetentionMinutes: 0,
    sessionIdleTimeoutMinutes: 0,
  });
  try {
    const record = await registry.create({ orgId: 7, prompt: "test" });
    await firstSeen;
    const proposal = {
      id: "p_1",
      sessionId: record.sid,
      orgId: 7,
      tool: "update_ticket_status",
      subjectType: "bug",
      subjectHashId: "bug_1",
      fromStatus: "new",
      toStatus: "accepted",
      reason: "确认处理",
      status: "pending" as const,
      expiresAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T01:00:01.000Z",
    };
    const lifecycle: ProposalLifecycleEvent = {
      event: "created",
      ts: proposal.updatedAt,
      actor: "agent",
      proposal,
    };
    await registry.syncProposalLifecycle(lifecycle);
    await registry.syncProposalLifecycle(lifecycle); // 同状态重复同步不应产生重复事件
    await assert.rejects(
      () => registry.syncProposalLifecycle({ ...lifecycle, proposal: { ...proposal, orgId: 8 } }),
      (error: unknown) => error instanceof GatewayError && error.status === 404,
    );
    secondRelease();
    for (let i = 0; i < 50 && record.status !== "succeeded"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      record.events.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      record.events.map((event) => event.type),
      ["status_change", "proposal_lifecycle", "status_change"],
    );
  } finally {
    await registry.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toEnvelopeJson：eventId 随 sessionId / seq 变化，是回放游标的事实来源", () => {
  const a = makeRecord({ sid: "s_a" });
  const b = makeRecord({ sid: "s_b" });
  const ev = (seq: number): EngineEvent => ({ type: "status_change", seq, ts: "t", status: "running" });

  assert.equal((JSON.parse(toEnvelopeJson(a, ev(1))) as { eventId: string }).eventId, "s_a:1");
  assert.equal((JSON.parse(toEnvelopeJson(b, ev(1))) as { eventId: string }).eventId, "s_b:1");
  assert.equal((JSON.parse(toEnvelopeJson(a, ev(9))) as { eventId: string }).eventId, "s_a:9");
});

test("sessionView：剥离句柄 / 订阅者 / 事件缓存等运行态", () => {
  const record = makeRecord({
    subjectType: "requirement",
    subjectId: "R-42",
    endedAt: "2026-08-29T02:00:00.000Z",
    events: [{ type: "status_change", seq: 1, ts: "t", status: "succeeded" }],
    subscribers: new Set([{ onEvent: () => undefined, onEnd: () => undefined }]),
    handle: {
      events: () => ({}) as never,
      send: async () => undefined,
      answerPermission: async () => undefined,
      cancel: async () => undefined,
      dispose: async () => undefined,
    },
    cancelRequested: true,
    closed: true,
    runtimeConfig: {
      provider: "openai",
      model: "gpt-5",
      env: { OPENAI_API_KEY: "must-not-leak" },
    },
  });

  const view = sessionView(record);
  assert.deepEqual(Object.keys(view).sort(), ["createdAt", "endedAt", "orgId", "prompt", "sid", "status", "subjectId", "subjectType"]);

  // 运行态字段绝不能出现在下发给客户端的视图里
  const leaked = view as unknown as Record<string, unknown>;
  for (const key of ["events", "subscribers", "handle", "cancelRequested", "closed", "runtimeConfig"]) {
    assert.equal(key in leaked, false, `${key} 不应出现在 SessionView`);
  }
});

test("SessionRegistry：运行配置只传给 driver，随后从记录和 JSONL 清除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-session-runtime-config-"));
  let captured: EngineRuntimeConfig | undefined;
  const driver: EngineDriver = {
    name: "runtime-config-test",
    async startSession(options) {
      captured = options.runtimeConfig;
      return {
        async *events() {
          yield { type: "status_change" as const, seq: 1, ts: "2026-09-03T00:00:00.000Z", status: "succeeded" as const };
        },
        async send() {},
        async answerPermission() {},
        async cancel() {},
        async dispose() {},
      };
    },
    async dispose() {},
  };
  const registry = await SessionRegistry.open(driver, {
    dataDir: dir,
    maxSessionsPerOrg: 3,
    sessionRetentionMinutes: 0,
    sessionIdleTimeoutMinutes: 0,
  });
  try {
    const runtimeConfig: EngineRuntimeConfig = {
      provider: "openai",
      model: "gpt-5",
      env: { OPENAI_API_KEY: "session-secret" },
    };
    const record = await registry.create({ orgId: 7, ownerActor: "user:100", prompt: "test", runtimeConfig });
    for (let i = 0; i < 20 && record.status !== "succeeded"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(captured, runtimeConfig);
    assert.equal(record.runtimeConfig, undefined);
    assert.equal("runtimeConfig" in sessionView(record), false);
    const jsonl = readFileSync(join(dir, "gateway.jsonl"), "utf8");
    assert.equal(JSON.parse(jsonl.split("\n")[0]).patch.ownerActor, "user:100");
    assert.equal(jsonl.includes("session-secret"), false);
    assert.equal(jsonl.includes("OPENAI_API_KEY"), false);
  } finally {
    await registry.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionView：可选字段缺省时在线上不出现（JSON 序列化会省略 undefined）", () => {
  const view = sessionView(makeRecord());
  assert.equal(view.endedAt, undefined);
  assert.equal(view.subjectType, undefined);
  assert.equal(view.subjectId, undefined);

  // 对象内键位存在但值为 undefined，JSON.stringify 会整键省略——这才是客户端实际收到的形态
  const wire = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire).sort(), ["createdAt", "orgId", "prompt", "sid", "status"]);
});

test("sessionView 是快照：后续改 record 不回写视图", () => {
  const record = makeRecord({ status: "running" });
  const view = sessionView(record);
  record.status = "failed";
  assert.equal(view.status, "running");
});

test("GatewayError 携带 HTTP 状态码与名称", () => {
  const err = new GatewayError(502, "上游引擎拒绝");
  assert.equal(err.status, 502);
  assert.equal(err.message, "上游引擎拒绝");
  assert.equal(err.name, "GatewayError");
  assert.ok(err instanceof Error);
  // http.ts 依赖 message 生成 { error } 信封，空文案也要保留类型
  assert.equal(new GatewayError(400, "").message, "");
});
