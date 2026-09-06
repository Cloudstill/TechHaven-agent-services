import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const BASE: NodeJS.ProcessEnv = {
  TECHHAVEN_BRIDGE_TOKEN: "bridge-secret-at-least-32-bytes-long",
  TECHHAVEN_LEGACY_BASE_URL: "https://legacy.example/api/v1/",
  TECHHAVEN_LEGACY_AUTH_VALUE: "legacy-secret",
};

test("最小配置装载默认值并裁剪 base URL", () => {
  const config = loadConfig(BASE);
  assert.equal(config.port, 3093);
  assert.equal(config.legacyBaseUrl, "https://legacy.example/api/v1");
  assert.equal(config.legacyRdPrefix, "/rd");
  assert.equal(config.legacyAuthMode, "bearer");
  assert.equal(config.legacyTimeoutMs, 5000);
});

test("Bridge token 和旧后端地址必填", () => {
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_BRIDGE_TOKEN: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_BRIDGE_TOKEN: "too-short" }), /至少 32 字节/);
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_LEGACY_BASE_URL: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_LEGACY_BASE_URL: "file:///tmp/legacy" }), /http 或 https/);
  assert.throws(
    () => loadConfig({ ...BASE, TECHHAVEN_LEGACY_BASE_URL: "https://user:pass@legacy.example/api/v1" }),
    /不得包含用户信息/,
  );
});

test("cookie/bearer 要求凭据，none 可省略", () => {
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_LEGACY_AUTH_VALUE: "" }), ConfigError);
  assert.equal(loadConfig({ ...BASE, TECHHAVEN_LEGACY_AUTH_MODE: "none", TECHHAVEN_LEGACY_AUTH_VALUE: "" }).legacyAuthMode, "none");
});

test("状态映射必须是无重复 canonical 值的 JSON 对象", () => {
  const config = loadConfig({ ...BASE, TECHHAVEN_LEGACY_STATUS_MAP_JSON: '{"bug":{"0":"new","1":"accepted"}}' });
  assert.deepEqual(config.statusMap, { bug: { "0": "new", "1": "accepted" } });
  assert.throws(() => loadConfig({ ...BASE, TECHHAVEN_LEGACY_STATUS_MAP_JSON: "{" }), ConfigError);
  assert.throws(
    () => loadConfig({ ...BASE, TECHHAVEN_LEGACY_STATUS_MAP_JSON: '{"bug":{"0":"new","1":"new"}}' }),
    /canonical 状态重复/,
  );
});
