import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "./http.js";
import { loadConfig } from "./config.js";
import { SessionRegistry } from "./sessions.js";
import { MockDriver } from "./drivers/mock.js";
import type { ProposalPort } from "./proposals.js";

test("all session routes reject another user and ownerless restored sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-access-"));
  const row = (sid: string, ownerActor?: string) =>
    JSON.stringify({
      kind: "session",
      sid,
      patch: { orgId: 7, ownerActor, status: "succeeded", createdAt: new Date().toISOString() },
    });
  await writeFile(join(dir, "gateway.jsonl"), [row("private", "user:100"), row("legacy")].join("\n") + "\n");
  const driver = new MockDriver();
  const registry = await SessionRegistry.open(driver, {
    dataDir: dir,
    maxSessionsPerOrg: 3,
    sessionRetentionMinutes: 0,
    sessionIdleTimeoutMinutes: 0,
  });
  let decisions = 0;
  const proposals: ProposalPort = {
    async listForSession() {
      return [];
    },
    async decide() {
      decisions++;
      throw new Error("must not reach here");
    },
    async close() {},
  };
  const server = createGatewayServer(
    loadConfig({ TECHHAVEN_GATEWAY_TOKEN: "test-token" }),
    registry,
    proposals,
    undefined,
    undefined,
    // 测试关注访问隔离：默认放行 orgAccess，让会话创建可走通；POST /v1/sessions 的
    // 拒绝路径见 http.test.ts 里专门的 OrgAccess 负向用例（审查意见 F1）。
    { requireMember: async () => undefined },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, actor: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: "Bearer test-token", "x-techhaven-actor": actor, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const own = await request("/v1/sessions", "user:100");
    assert.deepEqual(
      (await own.json()).sessions.map((s: { sid: string }) => s.sid),
      ["private"],
    );
    assert.equal((await request("/v1/sessions/private", "user:100")).status, 200);
    assert.deepEqual((await (await request("/v1/sessions", "user:200")).json()).sessions, []);
    for (const [suffix, method] of [
      ["", "GET"],
      ["/events", "GET"],
      ["/cancel", "POST"],
      ["/permission", "POST"],
      ["/proposals", "GET"],
      ["/proposals/p", "GET"],
      ["/proposals/p/decision", "POST"],
    ]) {
      const res = await request(
        `/v1/sessions/private${suffix}`,
        "user:200",
        method,
        method === "POST" ? { decision: "approve", requestId: "r" } : undefined,
      );
      assert.equal(res.status, 404, `${method} ${suffix}`);
    }
    assert.equal(decisions, 0);
    assert.equal((await request("/v1/sessions/legacy", "user:100")).status, 404);
    assert.equal((await request("/v1/sessions", "")).status, 401);
    assert.equal((await request("/v1/sessions", "", "POST", { orgId: 7, prompt: "hello" })).status, 401);
    const created = await request("/v1/sessions", "user:100", "POST", { orgId: 7, prompt: "private", ownerActor: "user:200" });
    assert.equal(created.status, 201);
    assert.equal(registry.get((await created.json()).sid)?.ownerActor, "user:100");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.dispose();
    await driver.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
