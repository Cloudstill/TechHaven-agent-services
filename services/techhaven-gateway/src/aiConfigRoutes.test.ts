import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./http.js";
import type { ProposalPort } from "./proposals.js";
import type { SessionRegistry } from "./sessions.js";
import type { AiConfigStore, AiConfigSummary } from "./aiConfigStore.js";
import type { AiConfigAsset } from "./aiConfigAssets.js";

const GATEWAY_TOKEN = "gateway-test-token";

test("配置路由复用协议规则，并按已有协议校验部分更新", async () => {
  const store = fakeStore();
  const patches: unknown[] = [];
  store.listByOwner = async () => [
    summary({ providerType: "claude", serviceProvider: "anthropic", responseType: "messages", maxTokens: 1024 }),
  ];
  store.update = async (_id, _scope, _owner, patch) => {
    patches.push(patch);
    return summary();
  };
  await withServer(store, async (base) => {
    const patch = await fetch(`${base}/v1/ai-configs/11`, {
      ...authedInit({ provider: "anthropic", response_type: "messages" }),
      method: "PATCH",
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(patches, [{ serviceProvider: "anthropic", responseType: "messages" }]);
    const mismatch = await fetch(
      `${base}/v1/ai-configs`,
      authedInit({ name: "invalid", type: "openai", provider: "anthropic", url: "https://api.example.com/v1", api_key: "sk-test" }),
    );
    assert.equal(mismatch.status, 400);
  });
});

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

const PLAIN_KEY = "sk-live-ultra-secret-9876";

function summary(overrides: Partial<AiConfigSummary> = {}): AiConfigSummary {
  return {
    id: 11,
    scope: "user",
    ownerId: 100,
    name: "工作 GPT",
    providerType: "openai",
    serviceProvider: "openai",
    responseType: "chat_completions",
    endpointUrl: "https://api.openai.com/v1/chat/completions",
    apiKeyMasked: "sk-***9876",
    model: "gpt-4o",
    isDefault: true,
    shared: false,
    status: "active",
    ...overrides,
  };
}

function asset(): AiConfigAsset {
  return { ...summary(), apiKey: PLAIN_KEY };
}

function fakeStore(): AiConfigStore {
  return {
    async getPreference() {
      return { orgId: 7 };
    },
    async listByOwner(scope: string) {
      if (scope === "user") {
        return [summary()];
      }
      return [
        summary({ id: 20, scope: "org", ownerId: 7, name: "公司公共", isDefault: true, shared: true }),
        summary({ id: 21, scope: "org", ownerId: 7, name: "未开放", shared: false }),
      ];
    },
    async create() {
      return summary({ id: 12, name: "新建", isDefault: false });
    },
    async resolveForRun() {
      return { config: asset(), source: "user_default", borrowedFromOrg: false };
    },
    async setPreference() {},
    async update() {
      return summary({ name: "改名后" });
    },
    async remove() {},
    async rotateKey() {
      return summary();
    },
    async usageWindows() {
      return {
        daily: { tokens: 100, requests: 2, costMicros: 5 },
        monthly: { tokens: 3000, requests: 40, costMicros: 150 },
      };
    },
    async usageTotal() {
      return { tokens: 9000, requests: 120, costMicros: 600, sessions: 8 };
    },
  } as unknown as AiConfigStore;
}

async function withServer(store: AiConfigStore | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const registry = {} as unknown as SessionRegistry;
  const server = createGatewayServer(
    loadConfig({ TECHHAVEN_GATEWAY_TOKEN: GATEWAY_TOKEN }),
    registry,
    emptyProposalPort(),
    undefined,
    store,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function authedInit(body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      "x-techhaven-actor": "user:100",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("未启用配置资产时路由返回 503 而非 404", async () => {
  await withServer(undefined, async (base) => {
    const res = await fetch(`${base}/v1/ai-configs`, authedInit());
    assert.equal(res.status, 503);
    const payload = (await res.json()) as { error: string };
    assert.match(payload.error, /未启用/);
  });
});

test("列表返回个人配置与已共享的组织配置，且不含明文密钥", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(`${base}/v1/ai-configs`, authedInit());
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      configs: Array<{ id: number; api_key: string }>;
      org_configs: Array<{ id: number; shared: boolean }>;
      preference: number | null;
    };
    assert.equal(payload.configs.length, 1);
    assert.equal(payload.configs[0].api_key, "sk-***9876", "api_key 字段是脱敏串");
    assert.equal(payload.org_configs.length, 1, "未共享的组织配置不应出现在成员列表里");
    assert.equal(payload.org_configs[0].id, 20);
    assert.equal(payload.preference, null);
  });
});

test("创建配置返回 201，视图字段与前端契约对齐", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(
      `${base}/v1/ai-configs`,
      authedInit({
        name: "新建",
        type: "openai",
        url: "https://api.openai.com/v1/chat/completions",
        api_key: "sk-new-key-1234",
      }),
    );
    assert.equal(res.status, 201);
    const payload = (await res.json()) as { name: string; response_type: string };
    assert.equal(payload.name, "新建");
    assert.equal(payload.response_type, "chat_completions", "缺省 response_type 按协议推断");
  });
});

test("resolve 预览绝不外泄明文密钥", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(`${base}/v1/ai-configs/resolve`, authedInit());
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("ultra-secret"), "响应不得包含明文密钥");
    assert.ok(!text.includes(PLAIN_KEY), "响应不得包含完整密钥");
    const payload = JSON.parse(text) as {
      config: { api_key: string };
      source: string;
      borrowed_from_org: boolean;
    };
    assert.equal(payload.config.api_key, "sk-***9876");
    assert.equal(payload.source, "user_default");
  });
});

test("配置不存在或不属于当前用户时返回 404", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(`${base}/v1/ai-configs/999`, authedInit());
    assert.equal(res.status, 404);
    const payload = (await res.json()) as { error: string };
    assert.match(payload.error, /未找到你的 AI 配置/);
  });
});

test("缺少可信 actor 时拒绝访问配置资产", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(`${base}/v1/ai-configs`, {
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    });
    assert.equal(res.status, 401);
  });
});

test("configuration mode is explicit and still requires authenticated identity", async () => {
  for (const [store, storage] of [
    [undefined, "legacy"],
    [fakeStore(), "assets"],
  ] as const) {
    await withServer(store, async (base) => {
      const response = await fetch(`${base}/v1/ai-configs/mode`, authedInit());
      assert.deepEqual(await response.json(), { storage });
      const anonymous = await fetch(`${base}/v1/ai-configs/mode`, { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } });
      assert.equal(anonymous.status, 401);
    });
  }
});
