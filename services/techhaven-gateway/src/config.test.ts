/**
 * 配置装载纯域单测（node:test + tsx，无新增依赖）。
 *
 * 只测不需要外部实例的分支：必填项、枚举、数值边界、schema 标识符注入。
 * 全部走 loadConfig(env) 显式传参，不读写真实 process.env，避免测试间互相污染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, type Config } from "./config.js";

/** 最小可用环境：只带必填的 gatewayToken */
const BASE: NodeJS.ProcessEnv = { TECHHAVEN_GATEWAY_TOKEN: "gateway-token" };

function load(patch: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ ...BASE, ...patch });
}

/** 断言 loadConfig 抛出带指定片段的 ConfigError */
function assertConfigError(patch: NodeJS.ProcessEnv, fragment: string): void {
  assert.throws(
    () => load(patch),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `应为 ConfigError，实际：${String(err)}`);
      assert.match(err.message, new RegExp(fragment));
      return true;
    },
  );
}

test("最小环境可装载，其余取文档默认值", () => {
  const config = load();
  assert.equal(config.port, 3091);
  assert.equal(config.driver, "mock");
  assert.equal(config.store, "jsonl");
  assert.equal(config.dataDir, "./data");
  assert.equal(config.proposalsFile, "../techhaven-mcp/audit/proposals.jsonl");
  assert.equal(config.maxSessionsPerOrg, 3);
  assert.equal(config.sessionRetentionMinutes, 30);
  assert.equal(config.sessionIdleTimeoutMinutes, 30);
  assert.equal(config.dbSchema, "public");
  assert.equal(config.aiConfigUrl, undefined);
  assert.equal(config.aiConfigServiceToken, undefined);
  assert.equal(config.aiConfigTimeoutMs, 5000);
  assert.equal(config.dshProviderOpenai, "openai");
  assert.equal(config.dshProviderClaude, "anthropic");
  assert.equal(config.dshProviderGlm, "glm");
});

test("gatewayToken 缺失或纯空白都拒绝启动", () => {
  assertConfigError({ TECHHAVEN_GATEWAY_TOKEN: "" }, "TECHHAVEN_GATEWAY_TOKEN");
  delete BASE.TECHHAVEN_GATEWAY_TOKEN;
  assert.throws(() => loadConfig({}), ConfigError);
  BASE.TECHHAVEN_GATEWAY_TOKEN = "gateway-token";
  // 纯空白：trim 后为空，等同于未提供
  assertConfigError({ TECHHAVEN_GATEWAY_TOKEN: "   " }, "TECHHAVEN_GATEWAY_TOKEN");
});

test("gatewayToken 两端空白被裁剪", () => {
  assert.equal(load({ TECHHAVEN_GATEWAY_TOKEN: "  tok  " }).gatewayToken, "tok");
});

test("proposal 共享文件可配置且会裁剪空白", () => {
  assert.equal(
    load({ TECHHAVEN_PROPOSALS_FILE: "  ./audit/custom-proposals.jsonl  " }).proposalsFile,
    "./audit/custom-proposals.jsonl",
  );
  assert.equal(load({ TECHHAVEN_PROPOSALS_FILE: "   " }).proposalsFile, "../techhaven-mcp/audit/proposals.jsonl");
});

test("端口：空值走默认，显式值须是 1~65535 整数", () => {
  assert.equal(load({ TECHHAVEN_GATEWAY_PORT: "" }).port, 3091);
  assert.equal(load({ TECHHAVEN_GATEWAY_PORT: "  8090  " }).port, 8090);
  assert.equal(load({ TECHHAVEN_GATEWAY_PORT: "1" }).port, 1);
  assert.equal(load({ TECHHAVEN_GATEWAY_PORT: "65535" }).port, 65535);

  assertConfigError({ TECHHAVEN_GATEWAY_PORT: "0" }, "1~65535");
  assertConfigError({ TECHHAVEN_GATEWAY_PORT: "65536" }, "1~65535");
  assertConfigError({ TECHHAVEN_GATEWAY_PORT: "3091.5" }, "1~65535");
  assertConfigError({ TECHHAVEN_GATEWAY_PORT: "abc" }, "1~65535");
  // 负数：-1 不是 1~65535 内的整数
  assertConfigError({ TECHHAVEN_GATEWAY_PORT: "-1" }, "1~65535");
});

test("driver 枚举大小写不敏感，越界值拒绝", () => {
  assert.equal(load({ TECHHAVEN_ENGINE_DRIVER: "DSH" }).driver, "dsh");
  assert.equal(load({ TECHHAVEN_ENGINE_DRIVER: "  Mock  " }).driver, "mock");
  assertConfigError({ TECHHAVEN_ENGINE_DRIVER: "claude" }, "mock \\| dsh");
});

test("store 枚举大小写不敏感，越界值拒绝", () => {
  // postgres 分支同时要求 dbUrl，一并给出（不建立连接）
  assert.equal(load({ TECHHAVEN_GATEWAY_STORE: "Postgres", TECHHAVEN_GATEWAY_DB_URL: "postgres://h/db" }).store, "postgres");
  assertConfigError({ TECHHAVEN_GATEWAY_STORE: "sqlite" }, "jsonl \\| postgres");
});

test("store=postgres 必须给出 dbUrl", () => {
  assertConfigError({ TECHHAVEN_GATEWAY_STORE: "postgres" }, "TECHHAVEN_GATEWAY_DB_URL");
  assertConfigError({ TECHHAVEN_GATEWAY_STORE: "postgres", TECHHAVEN_GATEWAY_DB_URL: "   " }, "TECHHAVEN_GATEWAY_DB_URL");
  // 给了 URL 即通过（不建立连接，连接由运行时负责）
  assert.equal(load({ TECHHAVEN_GATEWAY_STORE: "postgres", TECHHAVEN_GATEWAY_DB_URL: "postgres://u:p@h:5432/db" }).store, "postgres");
});

test("dbSchema 拒绝非标识符（防注入到 DDL）", () => {
  assert.equal(load({ TECHHAVEN_GATEWAY_DB_SCHEMA: "agent_poc" }).dbSchema, "agent_poc");
  assert.equal(load({ TECHHAVEN_GATEWAY_DB_SCHEMA: "  " }).dbSchema, "public");

  assertConfigError({ TECHHAVEN_GATEWAY_DB_SCHEMA: "public; DROP TABLE t" }, "合法标识符");
  assertConfigError({ TECHHAVEN_GATEWAY_DB_SCHEMA: "1abc" }, "合法标识符");
  assertConfigError({ TECHHAVEN_GATEWAY_DB_SCHEMA: "a-b" }, "合法标识符");
  assertConfigError({ TECHHAVEN_GATEWAY_DB_SCHEMA: 'pub"lic' }, "合法标识符");
});

test("配额 / 驻留 / 空闲：边界与非法值", () => {
  assert.equal(load({ TECHHAVEN_MAX_SESSIONS_PER_ORG: "1" }).maxSessionsPerOrg, 1);

  assertConfigError({ TECHHAVEN_MAX_SESSIONS_PER_ORG: "0" }, "正整数");
  assertConfigError({ TECHHAVEN_MAX_SESSIONS_PER_ORG: "-3" }, "正整数");
  assertConfigError({ TECHHAVEN_MAX_SESSIONS_PER_ORG: "2.5" }, "正整数");
  assertConfigError({ TECHHAVEN_MAX_SESSIONS_PER_ORG: "many" }, "正整数");

  // 0 是合法语义（关闭淘汰 / 关闭看门狗），负数不合法
  assert.equal(load({ TECHHAVEN_SESSION_RETENTION_MINUTES: "0" }).sessionRetentionMinutes, 0);
  assert.equal(load({ TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES: "0" }).sessionIdleTimeoutMinutes, 0);
  assertConfigError({ TECHHAVEN_SESSION_RETENTION_MINUTES: "-1" }, "正整数或 0");
  assertConfigError({ TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES: "-1" }, "正整数或 0");

  // 空串回落默认 30，而不是 Number("") 的 0 语义漂移
  assert.equal(load({ TECHHAVEN_SESSION_RETENTION_MINUTES: "  " }).sessionRetentionMinutes, 30);
});

test("dsh 选项透传：空串归一为 undefined", () => {
  const config = load({
    TECHHAVEN_DSH_BIN: "  /opt/dsh/bin/dsh  ",
    TECHHAVEN_DSH_PROFILE: "",
    TECHHAVEN_DSH_HOME: "   ",
  });
  assert.equal(config.dshBin, "/opt/dsh/bin/dsh");
  assert.equal(config.dshProfile, undefined);
  assert.equal(config.dshHome, undefined);
});

test("用户 AI 配置解析：URL 与服务 token 必须成对出现", () => {
  assertConfigError({ TECHHAVEN_AI_CONFIG_URL: "https://backend.example/internal/ai-config" }, "必须同时设置");
  assertConfigError({ TECHHAVEN_AI_CONFIG_SERVICE_TOKEN: "service-token" }, "必须同时设置");
  const config = load({
    TECHHAVEN_AI_CONFIG_URL: " https://backend.example/internal/ai-config ",
    TECHHAVEN_AI_CONFIG_SERVICE_TOKEN: " service-token ",
  });
  assert.equal(config.aiConfigUrl, "https://backend.example/internal/ai-config");
  assert.equal(config.aiConfigServiceToken, "service-token");
});

test("用户 AI 配置解析：只允许 HTTPS 或本机 HTTP，超时有界", () => {
  assertConfigError(
    { TECHHAVEN_AI_CONFIG_URL: "http://backend.example/config", TECHHAVEN_AI_CONFIG_SERVICE_TOKEN: "token" },
    "必须使用 HTTPS",
  );
  assert.equal(
    load({ TECHHAVEN_AI_CONFIG_URL: "http://127.0.0.1:8088/config", TECHHAVEN_AI_CONFIG_SERVICE_TOKEN: "token" }).aiConfigUrl,
    "http://127.0.0.1:8088/config",
  );
  assert.equal(load({ TECHHAVEN_AI_CONFIG_TIMEOUT_MS: "1500" }).aiConfigTimeoutMs, 1500);
  assertConfigError({ TECHHAVEN_AI_CONFIG_TIMEOUT_MS: "99" }, "100~60000");
  assertConfigError({ TECHHAVEN_AI_CONFIG_TIMEOUT_MS: "60001" }, "100~60000");
});

test("dsh provider route 可配置且拒绝非法标识", () => {
  const config = load({
    TECHHAVEN_DSH_PROVIDER_OPENAI: "company-openai",
    TECHHAVEN_DSH_PROVIDER_CLAUDE: "company.anthropic",
    TECHHAVEN_DSH_PROVIDER_GLM: "glm_v2",
  });
  assert.equal(config.dshProviderOpenai, "company-openai");
  assert.equal(config.dshProviderClaude, "company.anthropic");
  assert.equal(config.dshProviderGlm, "glm_v2");
  assertConfigError({ TECHHAVEN_DSH_PROVIDER_OPENAI: "OpenAI Route" }, "provider id");
});
