import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionVerifier } from "./verify.js";
import { extractToken } from "./verify.js";
import type { BffConfig } from "./config.js";

/**
 * BFF 身份桥路由：
 * - GET /healthz：存活探针（无鉴权，供 systemd/部署脚本健康检查）
 * - GET /internal/v1/session/actor：Nginx auth_request 子请求入口。
 *   校验会话后 200 且响应头带 X-TechHaven-Actor: user:<uid>；
 *   未登录/超时/后端异常一律 401——失败关闭，绝不放行不明身份。
 *
 * 该服务不持有任何秘密：它只是「会话→身份」的转换器，被攻破的最坏结果是
 * 返回 401（无法伪造身份，伪造需要产品后端认可同一个 token）。
 */

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  verifier: SessionVerifier,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();

  if (url.pathname === "/healthz" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "techhaven-bff" }));
    return;
  }

  if (url.pathname === "/internal/v1/session/actor" && method === "GET") {
    const token = extractToken(req.headers);
    if (!token) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing session token" }));
      return;
    }
    let userId: number | null;
    try {
      userId = await verifier.verifyToken(token);
    } catch (err) {
      log("会话验证异常（按未登录处理）：", err);
      userId = null;
    }
    if (userId === null) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "session invalid or expired" }));
      return;
    }
    // auth_request 只需要状态码 + 响应头；body 为空即可
    res.writeHead(200, {
      "x-techhaven-actor": `user:${userId}`,
      "content-length": "0",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not found" }));
}

export function createBffServer(verifier: SessionVerifier): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, verifier);
  });
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
    log("客户端连接异常：", err);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  return server;
}

/** 启动服务并挂接优雅关闭（供 index.ts 使用） */
export function startBffServer(config: BffConfig, verifier: SessionVerifier): http.Server {
  const server = createBffServer(verifier);
  server.on("error", (err) => {
    log(`HTTP 服务错误（端口 ${config.port} 可能被占用）：`, err);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log(`TechHaven BFF 监听 http://${config.host}:${config.port}（auth_request 入口 /internal/v1/session/actor）`);
  });
  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，优雅关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return server;
}
