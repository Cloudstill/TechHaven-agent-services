import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTtl, READ_SCOPE, signAgentToken, verifyAgentToken, WRITE_SCOPE, type AgentTokenPayload } from "./agentToken.js";

const SECRET = "unit-test-secret";
const now = () => Math.floor(Date.now() / 1000);

function payload(overrides: Partial<AgentTokenPayload> = {}): AgentTokenPayload {
  return {
    v: 1,
    sid: "sid-unit",
    org: 7,
    scopes: [READ_SCOPE, WRITE_SCOPE],
    iat: now() - 10,
    exp: now() + 3600,
    ...overrides,
  };
}

describe("agent token 签发与校验", () => {
  it("正常往返：签发后可用同一密钥验回", () => {
    const issued = payload();
    const result = verifyAgentToken(signAgentToken(issued, SECRET), SECRET);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.sid, issued.sid);
      assert.equal(result.payload.org, issued.org);
      assert.deepEqual(result.payload.scopes, issued.scopes);
    }
  });

  it("错误密钥的签名校验失败", () => {
    const result = verifyAgentToken(signAgentToken(payload(), SECRET), "another-secret");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /签名校验失败/);
  });

  it("格式错误（段数不对 / 前缀不对）被拒绝", () => {
    for (const bad of ["", "abc", "thm_v1.only-two", "thm_v2.a.b.c", "x.a.b"]) {
      const result = verifyAgentToken(bad, SECRET);
      assert.equal(result.ok, false, `${bad} 应被拒绝`);
      if (!result.ok) assert.match(result.reason, /格式不正确/);
    }
  });

  it("篡改 payload 后签名失效", () => {
    const token = signAgentToken(payload({ org: 7 }), SECRET);
    const [prefix, body, sig] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), org: 999 }),
    ).toString("base64url");
    const result = verifyAgentToken(`${prefix}.${tamperedBody}.${sig}`, SECRET);
    assert.equal(result.ok, false);
  });

  it("过期 token 被拒绝", () => {
    const result = verifyAgentToken(signAgentToken(payload({ exp: now() - 1 }), SECRET), SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /已过期/);
  });

  it("缺少 scope 被拒绝", () => {
    const result = verifyAgentToken(signAgentToken(payload({ scopes: [] }), SECRET), SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /scope/);
  });

  it("缺少 sid 被拒绝", () => {
    const result = verifyAgentToken(signAgentToken(payload({ sid: "" }), SECRET), SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /sid/);
  });

  it("org 非正数被拒绝", () => {
    for (const org of [0, -1, Number.NaN]) {
      const result = verifyAgentToken(signAgentToken(payload({ org }), SECRET), SECRET);
      assert.equal(result.ok, false, `org=${org} 应被拒绝`);
      if (!result.ok) assert.match(result.reason, /组织/);
    }
  });

  it("不支持的版本被拒绝", () => {
    const result = verifyAgentToken(signAgentToken(payload({ v: 2 as 1 }), SECRET), SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /版本/);
  });

  it("payload 非 JSON 时被拒绝", () => {
    const result = verifyAgentToken(`thm_v1.${Buffer.from("not-json").toString("base64url")}.sig`, SECRET);
    assert.equal(result.ok, false);
  });
});

describe("TTL 解析", () => {
  it("支持 m / h / d 单位", () => {
    assert.equal(parseTtl("30m"), 1800);
    assert.equal(parseTtl("2h"), 7200);
    assert.equal(parseTtl("1d"), 86400);
  });

  it("容忍首尾空格", () => {
    assert.equal(parseTtl("  15m  "), 900);
  });

  it("非法格式抛错", () => {
    for (const bad of ["", "30", "m30", "30x", "-5m", "1.5h"]) {
      assert.throws(() => parseTtl(bad), /无法解析 TTL/, `${bad} 应抛错`);
    }
  });
});
