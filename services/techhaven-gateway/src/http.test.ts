import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { AiConfigResolutionError, type AiConfigResolver } from "./aiConfig.js";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./http.js";
import type { OrgAccessPort } from "./orgAccess.js";
import type { ProposalPort } from "./proposals.js";
import type { SessionRecord, SessionRegistry } from "./sessions.js";
import type { EngineRuntimeConfig } from "./types.js";

const GATEWAY_TOKEN = "gateway-test-token";

/** 测试默认放行：把「调用者属于目标组织」的责任隔离在 orgAccess 模块；关注其他路由时可忽略。 */
const ALLOW_ALL_ORG_ACCESS: OrgAccessPort = { requireMember: async () => undefined };

/** 与审查意见 F1 对齐：精确控制成员关系，验证未授权请求被拦在创建会话之前。 */
class FakeOrgAccess implements OrgAccessPort {
  readonly calls: Array<{ actor: string; orgId: number }> = [];
  constructor(private readonly allowed: (actor: string, orgId: number) => boolean) {}
  async requireMember(actor: string, orgId: number): Promise<void> {
    this.calls.push({ actor, orgId });
    if (!this.allowed(actor, orgId)) {
      const err = new Error("无权使用该组织的 AI 配置");
      (err as { status?: number }).status = 403;
      throw err;
    }
  }
}

function emptyProposalPort(): ProposalPort {
  return {
    async listForSession() {
      return [];
    },
    async decide() {
      throw new Error("not used");
    },
    async close() {},
  };
}

async function withServer(
  resolver: AiConfigResolver,
  run: (base: string, getCreated: () => Record<string, unknown> | undefined) => Promise<void>,
  orgAccess: OrgAccessPort = ALLOW_ALL_ORG_ACCESS,
): Promise<void> {
  let created: Record<string, unknown> | undefined;
  const registry = {
    async create(input: Record<string, unknown>): Promise<SessionRecord> {
      created = input;
      return {
        sid: "s_test",
        orgId: input.orgId as number,
        prompt: input.prompt as string,
        status: "queued",
        createdAt: "2026-09-03T00:00:00.000Z",
        events: [],
        subscribers: new Set(),
      };
    },
  } as unknown as SessionRegistry;
  const server = createGatewayServer(
    loadConfig({ TECHHAVEN_GATEWAY_TOKEN: GATEWAY_TOKEN }),
    registry,
    emptyProposalPort(),
    resolver,
    undefined,
    orgAccess,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, () => created);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("创建会话只按可信 actor 解析配置，响应不回传 runtime secret", async () => {
  const runtimeConfig: EngineRuntimeConfig = {
    provider: "openai",
    model: "gpt-5",
    env: { OPENAI_API_KEY: "runtime-secret" },
  };
  let actorSeen = "";
  const resolver: AiConfigResolver = {
    async resolve(actor) {
      actorSeen = actor;
      return runtimeConfig;
    },
  };
  await withServer(resolver, async (base, getCreated) => {
    const noActor = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId: 1, prompt: "hello" }),
    });
    assert.equal(noActor.status, 401);
    assert.equal(actorSeen, "");

    const response = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "content-type": "application/json",
        "x-techhaven-actor": "user:42",
      },
      body: JSON.stringify({ orgId: 1, prompt: "hello" }),
    });
    assert.equal(response.status, 201);
    assert.equal(actorSeen, "user:42");
    assert.equal(getCreated()?.runtimeConfig, runtimeConfig);
    const raw = await response.text();
    assert.equal(raw.includes("runtime-secret"), false);
    assert.deepEqual(JSON.parse(raw), { sid: "s_test", status: "queued" });
  });
});

test("配置解析失败保持原状态码且不创建会话", async () => {
  const resolver: AiConfigResolver = {
    async resolve() {
      throw new AiConfigResolutionError(412, "请先完成 API 配置");
    },
  };
  await withServer(resolver, async (base, getCreated) => {
    const response = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "content-type": "application/json",
        "x-techhaven-actor": "user:9",
      },
      body: JSON.stringify({ orgId: 1, prompt: "hello" }),
    });
    assert.equal(response.status, 412);
    assert.equal(getCreated(), undefined);
    assert.deepEqual(await response.json(), { error: "请先完成 API 配置" });
  });
});
