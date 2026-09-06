/** Gateway routing and service authentication. Transport and AI asset routes live in dedicated modules. */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { ProposalPort } from "./proposals.js";
import { AiConfigResolutionError, type AiConfigResolver } from "./aiConfig.js";
import { AiConfigStoreError, type AiConfigStore } from "./aiConfigStore.js";
import { renderPrometheus } from "./metrics.js";
import { GatewayError, sessionView, type SessionRegistry } from "./sessions.js";
import { DenyAllOrgAccess, type OrgAccessPort } from "./orgAccess.js";
import { readJsonBody, sendJson, sendError, jsonObject, requireString, optionalString, trustedActor } from "./httpSupport.js";
import { handleEventsStream } from "./eventsStream.js";
import { handleAiConfigRoutes } from "./aiConfigRoutes.js";

/** 鉴权：常量时间比较，避免令牌逐字节探测 */
function authorized(req: IncomingMessage, gatewayToken: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(gatewayToken, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** POST /v1/sessions 请求体校验 */
function parseCreateBody(body: unknown): { orgId: number; subjectType?: string; subjectId?: string; prompt: string } {
  const record = jsonObject(body);
  const orgId = record.orgId;
  if (!Number.isInteger(orgId) || (orgId as number) < 1) {
    throw new GatewayError(400, "字段 orgId 必须是正整数");
  }
  const prompt = requireString(record, "prompt");
  if (!prompt || !prompt.trim()) throw new GatewayError(400, "字段 prompt 必填且不能为空白");
  return {
    orgId: orgId as number,
    subjectType: optionalString(record, "subjectType"),
    subjectId: optionalString(record, "subjectId"),
    prompt: prompt.trim(),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  registry: SessionRegistry,
  proposals: ProposalPort,
  aiConfigResolver?: AiConfigResolver,
  aiConfigStore?: AiConfigStore,
  /**
   * 组织授权端口（审查意见 F1）。缺省为 DenyAll：未接线时创建会话返回 503，
   * 而不是沿用「请求体说哪个组织就是哪个组织」的旧行为。
   */
  orgAccess: OrgAccessPort = new DenyAllOrgAccess(),
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  try {
    if (path === "/healthz" && method === "GET") {
      try {
        await registry.checkReady();
        sendJson(res, 200, { ok: true, driver: config.driver, store: config.store });
      } catch {
        sendJson(res, 503, { ok: false, driver: config.driver, store: config.store, error: "权威存储不可用" });
      }
      return;
    }

    // 鉴权：/healthz 之外一律要求 Bearer 令牌
    if (!authorized(req, config.gatewayToken)) {
      sendError(res, 401, "缺少或无效的 Bearer 令牌");
      return;
    }

    // Prometheus 抓取入口：同样要求 Bearer 令牌（会话数/订阅数也算内部状态，不对匿名开放）
    if (path === "/metrics" && method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(
        renderPrometheus({
          driver: config.driver,
          store: config.store,
          sessions: registry.list(),
          uptimeSeconds: process.uptime(),
          memoryBytes: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        }),
      );
      return;
    }

    if (path === "/v1/sessions" && method === "GET") {
      const actor = trustedActor(req);
      sendJson(res, 200, {
        sessions: registry
          .list()
          .filter((record) => record.ownerActor === actor)
          .map(sessionView),
      });
      return;
    }

    if (path === "/v1/sessions" && method === "POST") {
      const body = await readJsonBody(req);
      const input = parseCreateBody(body);
      const ownerActor = trustedActor(req);
      // 授权先于一切副作用：成员校验通过才会占用组织配额、解析配置、启动 runner。
      // orgId 来自请求体，未校验前一律不可信。
      await orgAccess.requireMember(ownerActor, input.orgId);
      // 同一个已授权 orgId 传给配置解析：组织共享配置的授权判定与会话归属必须一致。
      const runtimeConfig = aiConfigResolver ? await aiConfigResolver.resolve(ownerActor, input.orgId) : undefined;
      const record = await registry.create({ ...input, ownerActor, runtimeConfig });
      sendJson(res, 201, { sid: record.sid, status: record.status });
      return;
    }

    // Every session subresource shares the same authorization gate, including SSE,
    // runner permissions and product proposals. Legacy ownerless sessions stay private.
    const sessionPath = /^\/v1\/sessions\/([^/]+)(?:\/|$)/.exec(path);
    if (sessionPath) {
      const actor = trustedActor(req);
      const record = registry.get(decodeURIComponent(sessionPath[1]));
      if (!record || record.ownerActor !== actor) throw new GatewayError(404, "会话不存在或无权访问");
    }

    const detailMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (detailMatch && method === "GET") {
      const record = registry.get(decodeURIComponent(detailMatch[1]));
      if (!record) throw new GatewayError(404, `未知会话：${detailMatch[1]}`);
      sendJson(res, 200, sessionView(record));
      return;
    }

    if (path === "/v1/ai-configs" || path.startsWith("/v1/ai-configs/")) {
      await handleAiConfigRoutes(req, res, url, aiConfigStore);
      return;
    }

    const proposalListMatch = /^\/v1\/sessions\/([^/]+)\/proposals$/.exec(path);
    if (proposalListMatch && method === "GET") {
      const sid = decodeURIComponent(proposalListMatch[1]);
      const record = registry.get(sid);
      if (!record) throw new GatewayError(404, `未知会话：${sid}`);
      const snapshots = await proposals.listForSession(sid, record.orgId);
      for (const item of snapshots) await registry.syncProposalLifecycle(item.lifecycle);
      sendJson(res, 200, { proposals: snapshots.map((item) => item.proposal) });
      return;
    }

    const proposalMatch = /^\/v1\/sessions\/([^/]+)\/proposals\/([^/]+)(?:\/(decision))?$/.exec(path);
    if (proposalMatch) {
      const sid = decodeURIComponent(proposalMatch[1]);
      const proposalId = decodeURIComponent(proposalMatch[2]);
      const action = proposalMatch[3];
      const record = registry.get(sid);
      if (!record) throw new GatewayError(404, `未知会话：${sid}`);

      if (!action && method === "GET") {
        const snapshots = await proposals.listForSession(sid, record.orgId);
        const found = snapshots.find((item) => item.proposal.id === proposalId);
        if (!found) throw new GatewayError(404, "提案不存在或不属于当前会话");
        await registry.syncProposalLifecycle(found.lifecycle);
        sendJson(res, 200, found.proposal);
        return;
      }

      if (action === "decision" && method === "POST") {
        const body = jsonObject(await readJsonBody(req));
        const decision = body.decision;
        if (decision !== "approve" && decision !== "reject") {
          throw new GatewayError(400, '字段 decision 必须是 "approve" | "reject"');
        }
        const result = await proposals.decide({
          sessionId: sid,
          orgId: record.orgId,
          proposalId,
          decision,
          actor: trustedActor(req),
          note: optionalString(body, "note"),
        });
        await registry.syncProposalLifecycle(result.lifecycle);
        sendJson(res, 200, result.proposal);
        return;
      }
    }

    const subMatch = /^\/v1\/sessions\/([^/]+)\/(events|permission|cancel)$/.exec(path);
    if (subMatch) {
      const sid = decodeURIComponent(subMatch[1]);
      const action = subMatch[2];

      if (action === "events" && method === "GET") {
        const record = registry.get(sid);
        if (!record) throw new GatewayError(404, `未知会话：${sid}`);
        handleEventsStream(req, url, record, registry, res);
        return;
      }

      if (action === "permission" && method === "POST") {
        const body = await readJsonBody(req);
        const fields = jsonObject(body);
        const requestId = requireString(fields, "requestId");
        const decision = fields.decision;
        if (decision !== "approve" && decision !== "reject") {
          throw new GatewayError(400, '字段 decision 必须是 "approve" | "reject"');
        }
        const note = optionalString(fields, "note");
        await registry.answerPermission(sid, requestId, decision, note);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "cancel" && method === "POST") {
        await registry.cancel(sid);
        sendJson(res, 200, { ok: true });
        return;
      }

      throw new GatewayError(405, `${method} 不支持该资源`);
    }

    sendError(res, 404, "未找到路由");
  } catch (err) {
    if (err instanceof AiConfigResolutionError) {
      sendError(res, err.status, err.message);
      return;
    }
    if (err instanceof AiConfigStoreError) {
      sendError(res, err.status, err.message);
      return;
    }
    if (err instanceof GatewayError) {
      sendError(res, err.status, err.message);
      return;
    }
    log("请求处理异常：", err);
    if (!res.headersSent) sendError(res, 500, "内部错误");
    else res.destroy();
  }
}

/** 创建网关 HTTP 服务 */
export function createGatewayServer(
  config: Config,
  registry: SessionRegistry,
  proposals: ProposalPort,
  aiConfigResolver?: AiConfigResolver,
  aiConfigStore?: AiConfigStore,
  orgAccess?: OrgAccessPort,
): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, registry, proposals, aiConfigResolver, aiConfigStore, orgAccess);
  });
  // 显式消费 clientError：默认行为是销毁 socket 并可能打出未处理异常日志
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
    log("客户端连接异常：", err);
  });
  // SSE 长连接：关闭请求整体超时（默认 300s 会掐断长事件流）
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return server;
}
