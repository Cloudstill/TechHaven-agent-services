import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateUsage,
  AiConfigResolveError,
  dailyBucket,
  EMPTY_USAGE,
  evaluateQuotas,
  monthStart,
  resolveAiConfig,
  type AiConfigAsset,
  type AiConfigScope,
  type ConfigStatus,
} from "./aiConfigAssets.js";

interface Overrides {
  id?: number;
  scope?: AiConfigScope;
  ownerId?: number;
  name?: string;
  isDefault?: boolean;
  shared?: boolean;
  status?: ConfigStatus;
}

function asset(overrides: Overrides = {}): AiConfigAsset {
  return {
    id: overrides.id ?? 1,
    scope: overrides.scope ?? "user",
    ownerId: overrides.ownerId ?? 100,
    name: overrides.name ?? "默认配置",
    providerType: "openai",
    serviceProvider: "openai",
    responseType: "chat_completions",
    endpointUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: "sk-test",
    isDefault: overrides.isDefault ?? false,
    shared: overrides.shared ?? false,
    status: overrides.status ?? "active",
  };
}

const noPreference = { preferredConfigId: null, requestedName: null };

test("显式选中的个人配置优先命中", () => {
  const personal = asset({ id: 11, name: "工作 GPT", isDefault: false });
  const result = resolveAiConfig({
    userId: 100,
    preferredConfigId: 11,
    userConfigs: [asset({ id: 12, name: "默认", isDefault: true }), personal],
    orgConfigs: [],
  });
  assert.equal(result.config.id, 11);
  assert.equal(result.source, "explicit");
  assert.equal(result.borrowedFromOrg, false);
});

test("可显式借用组织的共享配置，并标记 borrowedFromOrg", () => {
  const orgShared = asset({ id: 20, scope: "org", ownerId: 7, isDefault: true, shared: true });
  const result = resolveAiConfig({
    userId: 100,
    preferredConfigId: 20,
    userConfigs: [asset({ id: 12, isDefault: true })],
    orgConfigs: [orgShared],
  });
  assert.equal(result.config.id, 20);
  assert.equal(result.source, "explicit");
  assert.equal(result.borrowedFromOrg, true);
});

test("显式选中不存在的配置时报 409，不静默回落", () => {
  assert.throws(
    () =>
      resolveAiConfig({
        userId: 100,
        preferredConfigId: 999,
        userConfigs: [asset({ id: 12, isDefault: true })],
        orgConfigs: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AiConfigResolveError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test("组织配置未共享时不可被成员使用", () => {
  assert.throws(
    () =>
      resolveAiConfig({
        userId: 100,
        preferredConfigId: 20,
        userConfigs: [],
        orgConfigs: [asset({ id: 20, scope: "org", ownerId: 7, isDefault: true, shared: false })],
      }),
    /不可用/,
  );
});

test("按名字选用个人配置", () => {
  const result = resolveAiConfig({
    userId: 100,
    requestedName: "测试 GLM",
    userConfigs: [asset({ id: 1, name: "工作 GPT" }), asset({ id: 2, name: "测试 GLM" })],
    orgConfigs: [],
  });
  assert.equal(result.config.id, 2);
  assert.equal(result.source, "user_named");
});

test("无偏好时回落个人默认配置", () => {
  const result = resolveAiConfig({
    userId: 100,
    ...noPreference,
    userConfigs: [asset({ id: 1, name: "备用" }), asset({ id: 2, name: "默认", isDefault: true })],
    orgConfigs: [asset({ id: 20, scope: "org", ownerId: 7, isDefault: true, shared: true })],
  });
  assert.equal(result.config.id, 2);
  assert.equal(result.source, "user_default");
});

test("个人无配置时借用组织默认配置", () => {
  const result = resolveAiConfig({
    userId: 100,
    ...noPreference,
    userConfigs: [],
    orgConfigs: [asset({ id: 20, scope: "org", ownerId: 7, isDefault: true, shared: true })],
  });
  assert.equal(result.config.id, 20);
  assert.equal(result.source, "org_default");
  assert.equal(result.borrowedFromOrg, true);
});

test("个人配置额度用完时自动回落到组织共享配置", () => {
  const result = resolveAiConfig({
    userId: 100,
    ...noPreference,
    userConfigs: [asset({ id: 1, isDefault: true, status: "quota_exceeded" })],
    orgConfigs: [asset({ id: 20, scope: "org", ownerId: 7, isDefault: true, shared: true })],
  });
  assert.equal(result.config.id, 20);
  assert.equal(result.source, "org_default");
});

test("个人配置被禁用时不参与解析", () => {
  assert.throws(
    () =>
      resolveAiConfig({
        userId: 100,
        ...noPreference,
        userConfigs: [asset({ id: 1, isDefault: true, status: "disabled" })],
        orgConfigs: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AiConfigResolveError);
      assert.equal(err.status, 412, "被禁用不算「已配置过」，应引导重新配置");
      return true;
    },
  );
});

test("有个人配置但全部不可用且无组织配置时报 409", () => {
  assert.throws(
    () =>
      resolveAiConfig({
        userId: 100,
        ...noPreference,
        userConfigs: [asset({ id: 1, isDefault: true, status: "quota_exceeded" })],
        orgConfigs: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AiConfigResolveError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test("配额未超限时放行", () => {
  const decision = evaluateQuotas(
    [
      { period: "daily", metric: "tokens", limitValue: 1000 },
      { period: "monthly", metric: "cost_micros", limitValue: 500_000_000 },
    ],
    {
      daily: { tokens: 999, requests: 0, costMicros: 0 },
      monthly: { tokens: 0, requests: 0, costMicros: 499_000_000 },
    },
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.exceeded.length, 0);
});

test("任一维度超限即拦截，并列出超限项", () => {
  const decision = evaluateQuotas([{ period: "daily", metric: "requests", limitValue: 10 }], {
    daily: { tokens: 0, requests: 10, costMicros: 0 },
    monthly: EMPTY_USAGE,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.exceeded.length, 1);
  assert.equal(decision.exceeded[0].metric, "requests");
});

test("未配置任何配额视为不限量", () => {
  const decision = evaluateQuotas([], {
    daily: { tokens: Number.MAX_SAFE_INTEGER, requests: 0, costMicros: 0 },
    monthly: EMPTY_USAGE,
  });
  assert.equal(decision.allowed, true);
});

test("日配额与月配额按各自窗口独立判定", () => {
  const rules = [
    { period: "daily" as const, metric: "tokens" as const, limitValue: 100 },
    { period: "monthly" as const, metric: "tokens" as const, limitValue: 10_000 },
  ];
  const windows = {
    daily: { tokens: 50, requests: 0, costMicros: 0 },
    monthly: { tokens: 9_999, requests: 0, costMicros: 0 },
  };
  assert.equal(evaluateQuotas(rules, windows).allowed, true);

  const nextDay = { daily: { tokens: 100, requests: 0, costMicros: 0 }, monthly: windows.monthly };
  const blocked = evaluateQuotas(rules, nextDay);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.exceeded.length, 1, "只应命中日配额，月配额仍富余");
  assert.equal(blocked.exceeded[0].period, "daily");
});

test("用量累加只接受非负增量", () => {
  const total = accumulateUsage(EMPTY_USAGE, { tokens: 100, requests: 2, costMicros: 5 });
  assert.deepEqual(total, { tokens: 100, requests: 2, costMicros: 5 });

  const more = accumulateUsage(total, { tokens: 50 });
  assert.equal(more.tokens, 150);
  assert.equal(more.requests, 2, "未提供的维度保持原值");

  assert.throws(() => accumulateUsage(total, { tokens: -1 }), /非负数/);
  assert.throws(() => accumulateUsage(total, { costMicros: Number.NaN }), /非负数/);
});

test("统计桶按 UTC 切分，跨时区不错位", () => {
  // 2026-03-01T23:30Z 在北京时间已是 3 月 2 日早上，但仍应计入 UTC 的 3 月 1 日
  const moment = new Date("2026-03-01T23:30:00.000Z");
  assert.equal(dailyBucket(moment), "2026-03-01");
  assert.equal(monthStart(moment), "2026-03-01");

  assert.equal(dailyBucket(new Date("2026-01-05T00:00:00.000Z")), "2026-01-05");
  assert.equal(monthStart(new Date("2026-12-31T23:59:59.000Z")), "2026-12-01");
});
