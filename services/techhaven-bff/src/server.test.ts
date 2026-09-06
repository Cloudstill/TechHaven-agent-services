import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { BffConfigError, loadBffConfig } from "./config.js";
import { extractToken, extractUserId, SessionVerifier, type SessionVerifierOptions } from "./verify.js";
import { createBffServer } from "./server.js";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test("缺少后端 base 时拒绝启动", () => {
  assert.throws(() => loadBffConfig({}), BffConfigError);
  assert.throws(() => loadBffConfig({}), /TECHHAVEN_API_BASE/);
});

test("后端 base 必须是 HTTPS，本机回环可用 HTTP", () => {
  assert.throws(() => loadBffConfig({ TECHHAVEN_API_BASE: "http://api.example.com" }), /HTTPS/);
  const config = loadBffConfig({ TECHHAVEN_API_BASE: "http://127.0.0.1:8080" });
  assert.equal(config.apiBase, "http://127.0.0.1:8080");
  const https = loadBffConfig({ TECHHAVEN_API_BASE: "https://techhaven.website:8080" });
  assert.equal(https.apiBase, "https://techhaven.website:8080");
});

test("默认值与监听配置", () => {
  const config = loadBffConfig({ TECHHAVEN_API_BASE: "https://api.example.com" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3092);
  assert.equal(config.verifyTimeoutMs, 3000);
  assert.equal(config.cacheTtlMs, 60000);
});

// ---------------------------------------------------------------------------
// token / userId 提取
// ---------------------------------------------------------------------------

test("Bearer 优先于 Cookie", () => {
  const token = extractToken({
    authorization: "Bearer abc123",
    cookie: "S_TOKEN=cookie-token; other=1",
  });
  assert.equal(token, "abc123");
});

test("仅 Cookie 时使用 S_TOKEN", () => {
  const token = extractToken({ cookie: "other=1; S_TOKEN=ct456; more=2" });
  assert.equal(token, "ct456");
});

test("无任何凭据时返回 null", () => {
  assert.equal(extractToken({}), null);
  assert.equal(extractToken({ cookie: "other=1" }), null);
  assert.equal(extractToken({ authorization: "Basic dXNlcg==" }), null);
});

test("errno 非 0 视为未登录", () => {
  assert.equal(extractUserId({ errno: 1101, msg: "未登录", used: 0.1 }), null);
  assert.equal(extractUserId({ errno: 1, data: { uid: 100 } }), null);
});

test("errno 0 时从 uid/user_id/id 提取正整数用户", () => {
  assert.equal(extractUserId({ errno: 0, data: { uid: 100 } }), 100);
  assert.equal(extractUserId({ errno: 0, data: { user_id: "101" } }), 101);
  assert.equal(extractUserId({ errno: 0, data: { id: 7 } }), 7);
});

test("字段缺失或非法时失败关闭", () => {
  assert.equal(extractUserId({ errno: 0, data: { name: "x" } }), null);
  assert.equal(extractUserId({ errno: 0, data: { uid: -3 } }), null);
  assert.equal(extractUserId({ errno: 0, data: { uid: 1.5 } }), null);
  assert.equal(extractUserId({ errno: 0 }), null);
  assert.equal(extractUserId("not-json-object"), null);
});

// ---------------------------------------------------------------------------
// 验证器：缓存 / 并发合并 / 失败不缓存
// ---------------------------------------------------------------------------

function okResponse(uid: number): Response {
  return new Response(JSON.stringify({ errno: 0, data: { uid } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function verifierOptions(fetchImpl: typeof fetch, overrides: Partial<SessionVerifierOptions> = {}): SessionVerifierOptions {
  return {
    apiBase: "http://127.0.0.1:1",
    timeoutMs: 1000,
    cacheTtlMs: 100,
    cacheMaxEntries: 10,
    fetchImpl,
    ...overrides,
  };
}

test("成功结果按 TTL 缓存，缓存期内不再调用后端", async () => {
  let calls = 0;
  const verifier = new SessionVerifier(
    verifierOptions(async () => {
      calls += 1;
      return okResponse(100);
    }),
  );
  assert.equal(await verifier.verifyToken("t1"), 100);
  assert.equal(await verifier.verifyToken("t1"), 100);
  assert.equal(calls, 1);
});

test("失败不缓存，下一次请求会重试后端", async () => {
  let calls = 0;
  const verifier = new SessionVerifier(
    verifierOptions(async () => {
      calls += 1;
      return new Response("", { status: 401 });
    }),
  );
  assert.equal(await verifier.verifyToken("bad"), null);
  assert.equal(await verifier.verifyToken("bad"), null);
  assert.equal(calls, 2, "失败结果不得进入缓存");
});

test("同一 token 的并发请求合并为一次后端调用", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const verifier = new SessionVerifier(
    verifierOptions(async () => {
      calls += 1;
      await gate;
      return okResponse(100);
    }),
  );
  const first = verifier.verifyToken("shared");
  const second = verifier.verifyToken("shared");
  const third = verifier.verifyToken("shared");
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [100, 100, 100]);
  assert.equal(calls, 1, "并发请求必须合并，防止对后端造成雪崩");
});

test("TTL 过期后重新调用后端", async () => {
  let calls = 0;
  let now = 1_000;
  const verifier = new SessionVerifier(
    verifierOptions(
      async () => {
        calls += 1;
        return okResponse(100);
      },
      { now: () => now },
    ),
  );
  assert.equal(await verifier.verifyToken("t"), 100);
  now += 50;
  assert.equal(await verifier.verifyToken("t"), 100, "TTL 内命中缓存");
  now += 100;
  assert.equal(await verifier.verifyToken("t"), 100, "TTL 过期重新验证");
  assert.equal(calls, 2);
});

test("缓存超容量时淘汰最旧条目", async () => {
  let calls = 0;
  const verifier = new SessionVerifier(
    verifierOptions(
      async () => {
        calls += 1;
        return okResponse(100);
      },
      { cacheMaxEntries: 2 },
    ),
  );
  await verifier.verifyToken("a");
  await verifier.verifyToken("b");
  await verifier.verifyToken("c");
  assert.equal(calls, 3);
  await verifier.verifyToken("b");
  assert.equal(calls, 3, "b 仍在缓存中");
  await verifier.verifyToken("a");
  assert.equal(calls, 4, "a 已淘汰，需重新验证");
});

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

async function withServer(
  fetchImpl: typeof fetch,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const verifier = new SessionVerifier(verifierOptions(fetchImpl));
  const server = createBffServer(verifier);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("healthz 无需鉴权", async () => {
  await withServer(
    async () => okResponse(100),
    async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    },
  );
});

test("actor 入口：有效 Bearer 返回 200 与身份头", async () => {
  await withServer(
    async () => okResponse(42),
    async (base) => {
      const res = await fetch(`${base}/internal/v1/session/actor`, {
        headers: { authorization: "Bearer valid-token" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-techhaven-actor"), "user:42");
      assert.equal(await res.text(), "", "auth_request 响应体应为空");
    },
  );
});

test("actor 入口：有效 S_TOKEN Cookie 返回身份", async () => {
  await withServer(
    async () => okResponse(9),
    async (base) => {
      const res = await fetch(`${base}/internal/v1/session/actor`, {
        headers: { cookie: "session_id=abc; S_TOKEN=ct; theme=dark" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-techhaven-actor"), "user:9");
    },
  );
});

test("actor 入口：无凭据或后端拒绝时返回 401", async () => {
  await withServer(
    async () => new Response(JSON.stringify({ errno: 1101 }), { status: 200 }),
    async (base) => {
      const noToken = await fetch(`${base}/internal/v1/session/actor`);
      assert.equal(noToken.status, 401);
      const invalid = await fetch(`${base}/internal/v1/session/actor`, {
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(invalid.status, 401);
    },
  );
});

test("actor 入口：后端超时/异常时失败关闭", async () => {
  await withServer(
    async () => {
      throw new Error("network down");
    },
    async (base) => {
      const res = await fetch(`${base}/internal/v1/session/actor`, {
        headers: { authorization: "Bearer any" },
      });
      assert.equal(res.status, 401);
    },
  );
});

test("未知路由 404", async () => {
  await withServer(
    async () => okResponse(1),
    async (base) => {
      const res = await fetch(`${base}/something-else`);
      assert.equal(res.status, 404);
    },
  );
});
