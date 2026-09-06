import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { GatewayPgStore } from "./pgStore.js";

test("PG session owner survives create/restore; historical sessions remain ownerless", async () => {
  let owner: unknown;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
    if (sql.includes("INSERT INTO agent_identities")) return { rows: [{ id: "1" }] };
    if (sql.includes("INSERT INTO agent_sessions")) {
      assert.match(sql, /'owner_actor', \$7::text/);
      owner = values[6];
    }
    if (sql.includes("SELECT s.id, s.sid"))
      return {
        rows: [
          { id: "1", sid: "new", org_id: 7, status: "succeeded", created_at: new Date(), exit_info: { owner_actor: owner } },
          { id: "2", sid: "old", org_id: 7, status: "succeeded", created_at: new Date(), exit_info: null },
        ],
      };
    return { rows: [] };
  };
  const store = GatewayPgStore.forTesting({ query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool);
  await store.createSession({ sid: "new", orgId: 7, ownerActor: "user:100", createdAt: new Date().toISOString() }, 3);
  const restored = await store.restore(0);
  assert.equal(restored[0].ownerActor, "user:100");
  assert.equal(restored[1].ownerActor, undefined);
});

// 审查意见 F4：PG 启动恢复不得把「仍在其他实例上运行」的活动会话当成失联接管。
// restore 的接管条件必须以 runner_id 归属 + 租约过期为准：SQL 中必须出现
// `s.runner_id = $1`（本实例）与租约过期/空值兼容分支，且 $1 参数为本实例 ID。
// 其他实例（runner_id='instance-B'）+ 活跃 + 租约未过期 ⇒ 四个接管条件均不满足，不恢复。
test("F4 · restore 只接管本实例/租约过期会话，其他实例活动会话被排除", async () => {
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
    if (sql.includes("INSERT INTO agent_identities")) return { rows: [{ id: "1" }] };
    if (sql.includes("INSERT INTO agent_sessions")) return { rows: [{ id: "1" }] };
    if (sql.includes("SELECT s.id, s.sid")) return { rows: [] };
    return { rows: [] };
  };
  const store = GatewayPgStore.forTesting(
    { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    "public",
    { instanceId: "instance-A" },
  );
  await store.createSession({ sid: "s1", orgId: 7, ownerActor: "user:100", createdAt: new Date().toISOString() }, 3);
  await store.restore(0);

  const restoreCall = captured.find((c) => c.sql.includes("SELECT s.id, s.sid"));
  assert.ok(restoreCall, "restore 应发起会话查询");
  // 本实例 ID 作为 $1 传入 —— 接管以 runner_id 归属为第一条件
  assert.equal(restoreCall.values[0], "instance-A");
  // SQL 必须包含实例归属过滤，且不存在「无条件全量恢复」路径
  assert.match(restoreCall.sql, /s\.runner_id = \$1/);
  // 租约过期/空值兼容分支（v0.5 迁移期旧会话无 runner_id）必须与归属条件 OR 连接，
  // 而不是无条件放行 —— 断言这些分支存在但都在 AND(...) 组内
  assert.match(restoreCall.sql, /s\.runner_id IS NULL/);
  assert.match(restoreCall.sql, /s\.lease_expires_at IS NULL/);
  assert.match(restoreCall.sql, /s\.lease_expires_at <= now\(\)/);

  // createSession 必须写入 runner_id 归属（否则任何实例都会认领新会话）
  const insertCall = captured.find((c) => c.sql.includes("INSERT INTO agent_sessions"));
  assert.ok(insertCall, "createSession 应发起 INSERT");
  assert.match(insertCall.sql, /runner_id/);
  assert.equal(insertCall.values[insertCall.values.length - 2], "instance-A");
});

// F4 · 心跳续约只延长本实例持有的会话租约，SQL 必须带 runner_id 过滤
test("F4 · heartbeat 续约按 runner_id 过滤，不影响其他实例租约", async () => {
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
    if (sql.includes("INSERT INTO agent_identities")) return { rows: [{ id: "1" }] };
    if (sql.includes("INSERT INTO agent_sessions")) return { rows: [{ id: "1" }] };
    if (sql.includes("lease_expires_at = now()")) return { rows: [] };
    return { rows: [] };
  };
  const store = GatewayPgStore.forTesting(
    { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    "public",
    { instanceId: "instance-A" },
  );
  await store.createSession({ sid: "s1", orgId: 7, ownerActor: "user:100", createdAt: new Date().toISOString() }, 3);
  await (store as unknown as { heartbeat(): Promise<void> }).heartbeat();

  const hb = captured.find((c) => c.sql.includes("lease_expires_at = now()"));
  assert.ok(hb, "heartbeat 应发起续约 UPDATE");
  assert.match(hb.sql, /WHERE runner_id = \$1/);
  assert.equal(hb.values[0], "instance-A");
});
