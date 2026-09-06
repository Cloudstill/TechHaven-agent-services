import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { AiConfigStore, AiConfigStoreError, StoreAiConfigResolver, type AiConfigSummary } from "./aiConfigStore.js";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  loadMasterKeys,
  maskSecret,
  secretFingerprint,
  type MasterKeySet,
} from "./aiConfigCrypto.js";
import type { MetaRow } from "./aiConfigStore.js";

type Route = [pattern: RegExp, respond: (sql: string, values: unknown[]) => { rows: object[]; rowCount?: number }];

interface FakeDb {
  pool: pg.Pool;
  log: Array<{ sql: string; values: unknown[] }>;
}

function fakeDb(routes: Route[]): FakeDb {
  const log: Array<{ sql: string; values: unknown[] }> = [];
  const respond = (sql: string, values: unknown[]): { rows: object[]; rowCount?: number } => {
    log.push({ sql, values });
    for (const [pattern, handler] of routes) {
      if (pattern.test(sql)) return handler(sql, values);
    }
    throw new Error(`测试未预期的 SQL：${sql.slice(0, 100)}`);
  };
  const client = {
    query: (sql: string, values?: unknown[]) => respond(sql, values ?? []),
    release: () => undefined,
  };
  const pool = {
    query: (sql: string, values?: unknown[]) => respond(sql, values ?? []),
    connect: async () => client,
  };
  return { pool: pool as unknown as pg.Pool, log };
}

function keySet(): MasterKeySet {
  return loadMasterKeys({ TECHHAVEN_AI_CONFIG_MASTER_KEY: generateMasterKey() });
}

const PLAIN_KEY = "sk-live-abcdef123456";

function metaRow(overrides: Partial<MetaRow> = {}): MetaRow {
  return {
    id: "11",
    scope: "user",
    owner_id: "100",
    name: "工作 GPT",
    provider_type: "openai",
    service_provider: "openai",
    response_type: "chat_completions",
    endpoint_url: "https://api.openai.com/v1/chat/completions",
    api_key_masked: maskSecret(PLAIN_KEY),
    model: "gpt-4o",
    reasoning_effort: null,
    max_tokens: 4096,
    is_default: true,
    shared: false,
    status: "active",
    last_used_at: null,
    ...overrides,
  };
}

test("create 写入的是密文，且指纹与脱敏串与明文对应", async () => {
  const keys = keySet();
  const { pool, log } = fakeDb([
    [/^BEGIN$/i, () => ({ rows: [] })],
    [
      /^INSERT INTO ai_configs/,
      (_sql, values) => ({
        rows: [
          metaRow({
            scope: values[0] as MetaRow["scope"],
            owner_id: String(values[1]),
            name: values[2] as string,
            provider_type: values[3] as MetaRow["provider_type"],
            service_provider: values[4] as MetaRow["service_provider"],
            response_type: values[5] as MetaRow["response_type"],
            endpoint_url: values[6] as string,
            api_key_masked: values[9] as string,
          }),
        ],
      }),
    ],
    [/^COMMIT$/i, () => ({ rows: [] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  const created: AiConfigSummary = await store.create({
    scope: "user",
    ownerId: 100,
    name: "工作 GPT",
    providerType: "openai",
    serviceProvider: "openai",
    responseType: "chat_completions",
    endpointUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: PLAIN_KEY,
    createdBy: 100,
  });

  const insert = log.find((entry) => /^INSERT INTO ai_configs/.test(entry.sql));
  assert.ok(insert, "应执行 INSERT");
  const [cipher, fingerprint, masked] = [insert.values[7], insert.values[8], insert.values[9]];
  assert.ok(Buffer.isBuffer(cipher), "密文应以 Buffer 写入");
  assert.equal(decryptSecret(cipher as Buffer, keys), PLAIN_KEY, "写入的密文可用同一主密钥解回");
  assert.equal(fingerprint, secretFingerprint(PLAIN_KEY));
  assert.equal(masked, maskSecret(PLAIN_KEY));
  assert.equal(created.apiKeyMasked, maskSecret(PLAIN_KEY));
  assert.equal(created.name, "工作 GPT");
});

test("create 设为默认时先清除同归属旧默认", async () => {
  const keys = keySet();
  const { pool, log } = fakeDb([
    [/^BEGIN$/i, () => ({ rows: [] })],
    [/^UPDATE ai_configs SET is_default = false/, () => ({ rows: [], rowCount: 1 })],
    [/^INSERT INTO ai_configs/, () => ({ rows: [metaRow()] })],
    [/^COMMIT$/i, () => ({ rows: [] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  await store.create({
    scope: "user",
    ownerId: 100,
    name: "新默认",
    providerType: "openai",
    serviceProvider: "openai",
    responseType: "chat_completions",
    endpointUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: PLAIN_KEY,
    isDefault: true,
    createdBy: 100,
  });

  const clearDefault = log.find((entry) => /SET is_default = false/.test(entry.sql));
  assert.ok(clearDefault, "设置默认前应清除旧默认");
  assert.deepEqual(clearDefault.values, ["user", 100], "清除范围限定在同 scope + 同 owner");
});

test("resolveForRun 按默认链路选中个人配置并解密", async () => {
  const keys = keySet();
  const cipher = encryptSecret(PLAIN_KEY, keys);
  const row = metaRow();
  const { pool } = fakeDb([
    [/FROM user_ai_preferences/, () => ({ rows: [{ org_id: null, active_config_id: null }] })],
    [/scope = 'user' AND owner_id/, () => ({ rows: [row] })],
    [/FROM ai_usage_daily/, () => ({ rows: [{ total_tokens: null, request_count: null, cost_micros: null }] })],
    [/FROM ai_quotas/, () => ({ rows: [] })],
    [/SELECT api_key_cipher/, () => ({ rows: [{ api_key_cipher: cipher }] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  const resolved = await store.resolveForRun({ userId: 100 });

  assert.equal(resolved.config.id, 11);
  assert.equal(resolved.source, "user_default");
  assert.equal(resolved.borrowedFromOrg, false);
  assert.equal(resolved.config.apiKey, PLAIN_KEY, "解密出的明文密钥只在内存中出现");
});

test("resolveForRun 配额超限时拒绝并报 429", async () => {
  const keys = keySet();
  const { pool } = fakeDb([
    [/FROM user_ai_preferences/, () => ({ rows: [] })],
    [/scope = 'user' AND owner_id/, () => ({ rows: [metaRow()] })],
    [/usage_date >=/, () => ({ rows: [{ total_tokens: "999999", request_count: "5", cost_micros: null }] })],
    [/usage_date = /, () => ({ rows: [{ total_tokens: "999999", request_count: "5", cost_micros: "0" }] })],
    [/FROM ai_quotas/, () => ({ rows: [{ period: "daily", metric: "tokens", limit_value: "500000" }] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  await assert.rejects(
    () => store.resolveForRun({ userId: 100 }),
    (err: unknown) => {
      assert.ok(err instanceof AiConfigStoreError);
      assert.equal(err.status, 429);
      assert.match(err.message, /超出配额/);
      return true;
    },
  );
});

test("recordUsage 使用 upsert 累加并落使用明细", async () => {
  const keys = keySet();
  const { pool, log } = fakeDb([
    [/^BEGIN$/i, () => ({ rows: [] })],
    [/INSERT INTO ai_usage_receipts/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO ai_usage_daily/, () => ({ rows: [] })],
    [/INSERT INTO ai_config_usages/, () => ({ rows: [] })],
    [/UPDATE ai_configs SET last_used_at/, () => ({ rows: [], rowCount: 1 })],
    [/^COMMIT$/i, () => ({ rows: [] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  await store.recordUsage({
    configId: 11,
    userId: 100,
    scopeSnapshot: "user",
    resolvedFrom: "user_default",
    sessionSid: "sid-1",
    delta: { sessions: 1, requests: 3, totalTokens: 1200, costMicros: 450 },
  });

  const upsert = log.find((entry) => /INSERT INTO ai_usage_daily/.test(entry.sql));
  assert.ok(upsert, "应执行日聚合 upsert");
  assert.ok(upsert.sql.includes("ON CONFLICT (config_id, usage_date) DO UPDATE"), "日聚合应为累加 upsert");
  assert.equal(upsert.values[3], 3, "requests 增量");
  assert.equal(upsert.values[6], 1200, "total_tokens 增量");

  const detail = log.find((entry) => /INSERT INTO ai_config_usages/.test(entry.sql));
  assert.ok(detail, "应写入使用明细");
  assert.equal(detail.values[4], "sid-1", "明细应关联会话");
  assert.equal(detail.values[2], "user_default", "明细应记录解析来源");
});

test("remove 未命中时抛 404", async () => {
  const keys = keySet();
  const { pool } = fakeDb([[/^DELETE FROM ai_configs/, () => ({ rows: [], rowCount: 0 })]]);
  const store = AiConfigStore.forTesting(pool, keys);
  await assert.rejects(
    () => store.remove(999, "user", 100),
    (err: unknown) => {
      assert.ok(err instanceof AiConfigStoreError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("update 走 COALESCE 保留未指定字段，且只影响本归属的行", async () => {
  const keys = keySet();
  const { pool, log } = fakeDb([
    [/^BEGIN$/i, () => ({ rows: [] })],
    [/UPDATE ai_configs SET is_default = false/, () => ({ rows: [], rowCount: 1 })],
    [/^UPDATE ai_configs SET\s+name/, () => ({ rows: [metaRow({ name: "改名后" })] })],
    [/^COMMIT$/i, () => ({ rows: [] })],
  ]);

  const store = AiConfigStore.forTesting(pool, keys);
  const updated = await store.update(11, "user", 100, { name: "改名后", isDefault: true });

  assert.equal(updated.name, "改名后");
  const updateStmt = log.find((entry) => /^UPDATE ai_configs SET\s+name/.test(entry.sql));
  assert.ok(updateStmt, "应执行 UPDATE");
  assert.equal(updateStmt.values[0], 11, "WHERE 条件应限定 id");
  assert.equal(updateStmt.values[1], "user", "WHERE 条件应限定 scope");
  assert.equal(updateStmt.values[2], 100, "WHERE 条件应限定 owner_id，防止越权改别人的配置");
});

test("key rotation and endpoint change share the same scoped update transaction", async () => {
  const keys = keySet();
  const { pool, log } = fakeDb([
    [/^BEGIN$|^COMMIT$/, () => ({ rows: [] })],
    [/^UPDATE ai_configs SET\s+name/, () => ({ rows: [metaRow()] })],
  ]);
  await AiConfigStore.forTesting(pool, keys).update(11, "user", 100, { apiKey: PLAIN_KEY, endpointUrl: "https://new.example/v1" });
  const writes = log.filter((q) => q.sql.startsWith("UPDATE"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].values[4], "https://new.example/v1");
  assert.equal(decryptSecret(writes[0].values[17] as Buffer, keys), PLAIN_KEY);
  assert.ok(!writes[0].values.includes(PLAIN_KEY));
});

test("organization preference and runtime resolution require a current membership grant", async () => {
  let member = false;
  const { pool, log } = fakeDb([
    [/FROM ai_org_memberships/, () => ({ rows: member ? [{}] : [] })],
    [/FROM user_ai_preferences/, () => ({ rows: [{ org_id: "7", active_config_id: null }] })],
    [/INSERT INTO user_ai_preferences/, () => ({ rows: [] })],
    [/SELECT id FROM ai_configs/, () => ({ rows: [] })],
  ]);
  const store = AiConfigStore.forTesting(pool, keySet());
  await assert.rejects(store.setPreference(100, 7, null), (err: AiConfigStoreError) => err.status === 403);
  assert.ok(!log.some((q) => q.sql.includes("INSERT")));
  member = true;
  await store.setPreference(100, 7, null);
  await assert.rejects(store.setPreference(100, 7, 999), (err: AiConfigStoreError) => err.status === 404);
  member = false;
  await assert.rejects(store.resolveForRun({ userId: 100 }), (err: AiConfigStoreError) => err.status === 403);
  assert.ok(!log.some((q) => q.sql.includes("api_key_cipher")));
  // Revoked members can clear stale context without regaining access.
  await store.setPreference(100, null, null);
});

test("runtime accounting persists config provenance, deduplicates events and blocks next run at quota", async () => {
  const keys = keySet();
  let requests = 0;
  const receipts = new Set<string>();
  const { pool, log } = fakeDb([
    [/^BEGIN$|^COMMIT$/, () => ({ rows: [] })],
    [/FROM user_ai_preferences/, () => ({ rows: [] })],
    [/scope = 'user' AND owner_id/, () => ({ rows: [metaRow()] })],
    [/FROM ai_usage_daily/, () => ({ rows: [{ total_tokens: 0, request_count: requests, cost_micros: 0 }] })],
    [/FROM ai_quotas/, () => ({ rows: [{ period: "daily", metric: "requests", limit_value: "1" }] })],
    [/SELECT api_key_cipher/, () => ({ rows: [{ api_key_cipher: encryptSecret(PLAIN_KEY, keys) }] })],
    [
      /INSERT INTO ai_usage_receipts/,
      (_sql, values) => {
        const key = JSON.stringify(values);
        if (receipts.has(key)) return { rows: [], rowCount: 0 };
        receipts.add(key);
        return { rows: [], rowCount: 1 };
      },
    ],
    [
      /INSERT INTO ai_usage_daily/,
      (_sql, values) => {
        requests += Number(values[3]);
        return { rows: [] };
      },
    ],
    [/INSERT INTO ai_config_usages|UPDATE ai_configs SET last_used_at/, () => ({ rows: [] })],
  ]);
  const resolver = new StoreAiConfigResolver(AiConfigStore.forTesting(pool, keys));
  const runtime = await resolver.resolve("user:100");
  assert.ok(runtime.recordUsage);
  await runtime.recordUsage("s_1", "request:1:1", { requests: 1 });
  await runtime.recordUsage("s_1", "request:1:1", { requests: 1 });
  assert.equal(requests, 1);
  const detail = log.find((q) => q.sql.includes("INSERT INTO ai_config_usages"))!;
  assert.deepEqual(detail.values.slice(0, 5), [11, "user", "user_default", 100, "s_1"]);
  await assert.rejects(resolver.resolve("user:100"), (err: AiConfigStoreError) => err.status === 429);
});
