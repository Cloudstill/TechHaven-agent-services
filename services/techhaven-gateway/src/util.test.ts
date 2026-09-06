/**
 * 共享工具纯域单测（node:test + tsx，无新增依赖）。
 *
 * sha256Hex16 的向量与 services/techhaven-mcp/src/audit.test.ts 逐一相同：两个服务各自持有
 * 一份逐字同构的摘要实现（防漂移设计），改变其中任一侧的序列化语义都必须同时改这两个文件，
 * 因此用同一组硬编码向量把跨服务契约钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, isRecord, nowIso, sha256Hex16, sleep } from "./util.js";

test("nowIso 返回可解析的 ISO 8601 UTC 时间戳", () => {
  const iso = nowIso();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Number.isNaN(Date.parse(iso)), false);
});

test("errorMessage：Error 取 message，其余 String()", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(42), "42");
  // 关键：非 Error 抛出物不能被吞成空串
  assert.equal(errorMessage({ code: "E" }), "[object Object]");
  assert.equal(errorMessage(undefined), "undefined");
});

test("isRecord：非空普通对象，排除 null / 数组 / 原始值", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1]), false);
  assert.equal(isRecord("s"), false);
  assert.equal(isRecord(0), false);
  assert.equal(isRecord(new Date()), true);
});

test("sleep：至少等待指定毫秒，0 也合法", async () => {
  const start = Date.now();
  await sleep(0);
  assert.ok(Date.now() - start >= 0);

  const start2 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start2 >= 15, "sleep(20) 应至少等待约 20ms");
});

test("sha256Hex16：跨服务固定向量（与 techhaven-mcp 的 sha256Digest 同值）", () => {
  // undefined 与 null 归一为同一摘要（JSON.stringify(undefined ?? null) === "null"）
  assert.equal(sha256Hex16(undefined), "74234e98afe7498f");
  assert.equal(sha256Hex16(null), "74234e98afe7498f");

  assert.equal(sha256Hex16({ tool: "rd.ticket.update", args: { id: 42, tags: ["a", "b"] } }), "39c8bd11b31bf724");
  assert.equal(sha256Hex16("techhaven"), "3e41bb0921603dc0");
  assert.equal(sha256Hex16(0), "5feceb66ffc86f38");
});

test("sha256Hex16：确定性、长度固定、不同输入不碰撞", () => {
  const value = { a: 1, b: [2, 3] };
  assert.equal(sha256Hex16(value), sha256Hex16({ ...value }));
  assert.equal(sha256Hex16(value).length, 16);
  assert.match(sha256Hex16(value), /^[0-9a-f]{16}$/);
  assert.notEqual(sha256Hex16({ a: 1 }), sha256Hex16({ a: 2 }));
  // 键序敏感：与 JSON.stringify 语义一致，不代表语义相等
  assert.notEqual(sha256Hex16({ a: 1, b: 2 }), sha256Hex16({ b: 2, a: 1 }));
});
