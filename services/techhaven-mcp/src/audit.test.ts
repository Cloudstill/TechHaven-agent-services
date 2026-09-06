/**
 * sha256Digest 纯域单测（node:test + tsx，无新增依赖）。
 *
 * 向量与 services/techhaven-gateway/src/util.test.ts 的 sha256Hex16 逐一相同：两个服务各自持有
 * 一份逐字同构的摘要实现（防漂移设计），argsDigest 会跨服务流转（MCP 审计 → 网关事件 → 前端），
 * 因此用同一组硬编码向量把跨服务契约钉死——任一侧改了序列化语义都会在这里红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Digest } from "./audit.js";

test("sha256Digest：跨服务固定向量（与 techhaven-gateway 的 sha256Hex16 同值）", () => {
  // undefined 与 null 归一为同一摘要（JSON.stringify(undefined ?? null) === "null"）
  assert.equal(sha256Digest(undefined), "74234e98afe7498f");
  assert.equal(sha256Digest(null), "74234e98afe7498f");

  assert.equal(sha256Digest({ tool: "rd.ticket.update", args: { id: 42, tags: ["a", "b"] } }), "39c8bd11b31bf724");
  assert.equal(sha256Digest("techhaven"), "3e41bb0921603dc0");
  assert.equal(sha256Digest(0), "5feceb66ffc86f38");
});

test("sha256Digest：确定性、长度固定、不同输入不碰撞", () => {
  const value = { a: 1, b: [2, 3] };
  assert.equal(sha256Digest(value), sha256Digest({ ...value }));
  assert.equal(sha256Digest(value).length, 16);
  assert.match(sha256Digest(value), /^[0-9a-f]{16}$/);
  assert.notEqual(sha256Digest({ a: 1 }), sha256Digest({ a: 2 }));
  // 键序敏感：与 JSON.stringify 语义一致，不代表语义相等
  assert.notEqual(sha256Digest({ a: 1, b: 2 }), sha256Digest({ b: 2, a: 1 }));
});

test("sha256Digest：不落原始参数（审计日志只存摘要）", () => {
  // 摘要本身不得包含原文片段——工具参数可能含敏感内容
  const digest = sha256Digest({ token: "supersecret-value" });
  assert.equal(digest.includes("supersecret"), false);
  assert.equal(digest.length, 16);
});
