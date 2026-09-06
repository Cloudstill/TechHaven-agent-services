import test from "node:test";
import assert from "node:assert/strict";
import { AiConfigResolutionError, HttpAiConfigResolver, normalizeProviderBaseUrl } from "./aiConfig.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("OpenAI 配置经内部服务解析为隔离 runtime 配置", async () => {
  let requested: URL | undefined;
  let headers: Headers | undefined;
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/internal/v1/agent/ai-config",
    serviceToken: "service-token",
    timeoutMs: 1000,
    providerIds: { openai: "company-openai" },
    fetchImpl: async (input, init) => {
      requested = new URL(String(input));
      headers = new Headers(init?.headers);
      return jsonResponse({
        data: {
          type: "openai",
          url: "https://api.openai.com/v1/chat/completions",
          api_key: "sk-live-secret",
          model: "gpt-5",
          reasoning_effort: "high",
          max_tokens: 4096,
        },
      });
    },
  });

  const config = await resolver.resolve("user:42");
  assert.equal(requested?.searchParams.get("user_id"), "42");
  assert.equal(headers?.get("authorization"), "Bearer service-token");
  assert.equal(headers?.get("x-techhaven-actor"), "user:42");
  assert.deepEqual(config, {
    provider: "company-openai",
    model: "gpt-5",
    reasoningEffort: "high",
    maxTokens: 4096,
    env: {
      OPENAI_API_KEY: "sk-live-secret",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
    },
  });
});

test("OpenAI Responses 配置按 /responses 资源地址归一化", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse({
        type: "openai",
        provider: "openai",
        response_type: "responses",
        url: "https://api.openai.com/v1/responses",
        api_key: "sk-live-secret",
      }),
  });
  const config = await resolver.resolve("user:8");
  assert.equal(config.env.OPENAI_BASE_URL, "https://api.openai.com/v1");
});

test("旧后端未返回 response_type 时可从 /responses 地址推断", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse({
        type: "openai",
        url: "https://api.openai.com/v1/responses",
        api_key: "sk-live-secret",
      }),
  });
  const config = await resolver.resolve("user:9");
  assert.equal(config.env.OPENAI_BASE_URL, "https://api.openai.com/v1");
});

test("Claude 使用默认模型并要求 max_tokens", async () => {
  const fetchImpl = async () =>
    jsonResponse({ type: "claude", url: "https://api.anthropic.com/v1/messages", api_key: "sk-ant-secret", max_tokens: 2048 });
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl,
  });
  const config = await resolver.resolve("user:7");
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "claude-sonnet-4-6");
  assert.equal(config.maxTokens, 2048);
  assert.equal(config.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1");
});

test("脱敏密钥、非可信 actor 与不安全 endpoint 全部失败关闭", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse({ type: "glm", url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", api_key: "abc****xyz" }),
  });
  await assert.rejects(() => resolver.resolve("browser:1"), AiConfigResolutionError);
  await assert.rejects(
    () => resolver.resolve("user:1"),
    (error: unknown) => error instanceof AiConfigResolutionError && error.status === 412 && !error.message.includes("abc"),
  );
  assert.throws(() => normalizeProviderBaseUrl("http://provider.example/v1/chat/completions", "openai"), AiConfigResolutionError);
  assert.equal(normalizeProviderBaseUrl("http://127.0.0.1:11434/v1/chat/completions", "openai"), "http://127.0.0.1:11434/v1");
});

test("服务商、协议和接口类型组合不兼容时失败关闭", async () => {
  const makeResolver = (payload: Record<string, unknown>) =>
    new HttpAiConfigResolver({
      endpoint: "https://backend.example/config",
      serviceToken: "token",
      timeoutMs: 1000,
      fetchImpl: async () => jsonResponse(payload),
    });
  const base = { url: "https://api.example.com/v1/responses", api_key: "sk-ok" };

  await assert.rejects(
    () => makeResolver({ ...base, type: "openai", provider: "anthropic", response_type: "responses" }).resolve("user:1"),
    (error: unknown) => error instanceof AiConfigResolutionError && error.status === 502,
  );
  await assert.rejects(
    () =>
      makeResolver({ ...base, type: "claude", provider: "anthropic", response_type: "responses", max_tokens: 1024 }).resolve("user:1"),
    (error: unknown) => error instanceof AiConfigResolutionError && error.status === 502,
  );
});

test("内部服务错误不会把响应体或凭据带入错误信息", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "service-secret",
    timeoutMs: 1000,
    fetchImpl: async () => new Response("upstream leaked-key", { status: 500 }),
  });
  await assert.rejects(
    () => resolver.resolve("user:1"),
    (error: unknown) =>
      error instanceof AiConfigResolutionError &&
      error.status === 503 &&
      !error.message.includes("leaked-key") &&
      !error.message.includes("service-secret"),
  );
});

test("超长密钥、超长模型名与超限 max_tokens 全部拒绝且不回显值", async () => {
  const cases: Array<{ payload: Record<string, unknown>; status: number; needle?: string }> = [
    {
      payload: { type: "openai", url: "https://api.example.com/v1/chat/completions", api_key: "a".repeat(8193) },
      status: 412,
    },
    {
      payload: {
        type: "openai",
        url: "https://api.example.com/v1/chat/completions",
        api_key: "sk-ok",
        model: "m".repeat(257),
      },
      status: 502,
    },
    {
      payload: {
        type: "openai",
        url: "https://api.example.com/v1/chat/completions",
        api_key: "sk-ok",
        max_tokens: 0,
      },
      status: 502,
    },
    {
      payload: {
        type: "openai",
        url: "https://api.example.com/v1/chat/completions",
        api_key: "sk-ok",
        max_tokens: 1_000_001,
      },
      status: 502,
    },
  ];
  for (const { payload, status, needle } of cases) {
    const resolver = new HttpAiConfigResolver({
      endpoint: "https://backend.example/config",
      serviceToken: "token",
      timeoutMs: 1000,
      fetchImpl: async () => jsonResponse(payload),
    });
    await assert.rejects(
      () => resolver.resolve("user:1"),
      (error: unknown) => {
        assert.ok(error instanceof AiConfigResolutionError);
        assert.equal(error.status, status);
        if (needle) assert.ok(!error.message.includes(needle));
        // 超长值本身绝不进入错误信息
        assert.ok(error.message.length < 200);
        return true;
      },
    );
  }
});

test("响应体超过大小上限时失败关闭", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
  });
  await assert.rejects(
    () => resolver.resolve("user:1"),
    (error: unknown) => error instanceof AiConfigResolutionError && error.status === 502,
  );
});

test("合法的边界值（上限内密钥/模型名/max_tokens）正常解析", async () => {
  const resolver = new HttpAiConfigResolver({
    endpoint: "https://backend.example/config",
    serviceToken: "token",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse({
        type: "openai",
        url: "https://api.example.com/v1/chat/completions",
        api_key: "a".repeat(8192),
        model: "m".repeat(256),
        max_tokens: 1_000_000,
      }),
  });
  const config = await resolver.resolve("user:1");
  assert.equal(config.maxTokens, 1_000_000);
  assert.equal(config.model, "m".repeat(256));
});

test("reasoning_effort 缺省省略、空串视为未配置、非法值失败关闭", async () => {
  const makeResolver = (payload: Record<string, unknown>) =>
    new HttpAiConfigResolver({
      endpoint: "https://backend.example/config",
      serviceToken: "token",
      timeoutMs: 1000,
      fetchImpl: async () => jsonResponse(payload),
    });
  const base = { type: "openai", url: "https://api.example.com/v1/chat/completions", api_key: "sk-ok" };

  // 缺省 → 不含该键
  const absent = await makeResolver({ ...base }).resolve("user:1");
  assert.ok(!("reasoningEffort" in absent));

  // 空串 / null → 视为未配置
  const blank = await makeResolver({ ...base, reasoning_effort: "" }).resolve("user:1");
  assert.ok(!("reasoningEffort" in blank));

  // 合法值原样透传
  const valid = await makeResolver({ ...base, reasoning_effort: "max" }).resolve("user:1");
  assert.equal(valid.reasoningEffort, "max");

  // 非字符串 / 含空白 / 超长 → 失败关闭且不回显值
  for (const bad of [123, "low high", "x".repeat(65)]) {
    await assert.rejects(
      () => makeResolver({ ...base, reasoning_effort: bad }).resolve("user:1"),
      (error: unknown) => {
        assert.ok(error instanceof AiConfigResolutionError);
        assert.equal(error.status, 502);
        assert.ok(error.message.length < 120);
        return true;
      },
    );
  }
});
