import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeConfig } from "./config.js";
import { BridgeError, BridgeService } from "./bridgeService.js";
import { LegacyBackendError } from "./legacyClient.js";
import { TICKET_KINDS, type RequestIdentity, type TicketKind } from "./types.js";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function authorized(req: IncomingMessage, expectedToken: string): boolean {
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  if (!match) return false;
  const actual = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function identity(req: IncomingMessage): RequestIdentity {
  const sessionHeader = req.headers["x-techhaven-session"];
  const orgHeader = req.headers["x-techhaven-org"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const orgRaw = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;
  const orgId = Number(orgRaw);
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 128) {
    throw new BridgeError(400, "BAD_IDENTITY", "缺少有效 X-TechHaven-Session");
  }
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new BridgeError(400, "BAD_IDENTITY", "缺少有效 X-TechHaven-Org");
  }
  return { sessionId: sessionId.trim(), orgId };
}

function ticketKind(value: string): TicketKind {
  if (!(TICKET_KINDS as readonly string[]).includes(value)) {
    throw new BridgeError(400, "BAD_KIND", `不支持的工单类型：${value}`);
  }
  return value as TicketKind;
}

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new BridgeError(400, "BAD_REQUEST", `${field} 必须是正整数`);
  return parsed;
}

function optionalPositiveInt(value: string | null, field: string): number | undefined {
  return value === null || value === "" ? undefined : positiveInt(value, field);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new BridgeError(413, "BODY_TOO_LARGE", "请求体超过 1MB 上限");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError(400, "BAD_REQUEST", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, key: string, min = 1): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length < min) {
    throw new BridgeError(400, "BAD_REQUEST", `${key} 必须是至少 ${min} 个字符的字符串`);
  }
  return value.trim();
}

async function handle(req: IncomingMessage, res: ServerResponse, config: BridgeConfig, service: BridgeService): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (url.pathname === "/healthz" && method === "GET") {
      sendJson(res, 200, { ok: true, service: "techhaven-agent-bridge" });
      return;
    }
    if (!authorized(req, config.bridgeToken)) {
      sendError(res, 401, "UNAUTHORIZED", "缺少或无效的 Bridge Bearer 令牌");
      return;
    }
    const actor = identity(req);

    const detail = /^\/internal\/v1\/tickets\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (detail && method === "GET") {
      const ticket = await service.getTicket(actor.orgId, ticketKind(decodeURIComponent(detail[1])), positiveInt(detail[2], "id"));
      if (!ticket) throw new BridgeError(404, "NOT_FOUND", "旧后端中未找到目标工单");
      sendJson(res, 200, { ticket });
      return;
    }

    const transition = /^\/internal\/v1\/tickets\/([^/]+)\/(\d+)\/transition$/.exec(url.pathname);
    if (transition && method === "POST") {
      const idempotencyHeader = req.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 160) {
        throw new BridgeError(400, "BAD_IDEMPOTENCY_KEY", "缺少有效 Idempotency-Key");
      }
      const body = await readJson(req);
      const result = await service.transition({
        ...actor,
        kind: ticketKind(decodeURIComponent(transition[1])),
        id: positiveInt(transition[2], "id"),
        toStatus: requiredText(body, "toStatus"),
        reason: requiredText(body, "reason", 4),
        ...(typeof body.expectedFromStatus === "string" && body.expectedFromStatus.trim()
          ? { expectedFromStatus: body.expectedFromStatus.trim() }
          : {}),
        idempotencyKey: idempotencyKey.trim(),
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/internal/v1/tickets" && method === "GET") {
      const kindRaw = url.searchParams.get("kind");
      const page = await service.listTickets(actor.orgId, {
        ...(kindRaw ? { kind: ticketKind(kindRaw) } : {}),
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
        ...(optionalPositiveInt(url.searchParams.get("page"), "page")
          ? { page: optionalPositiveInt(url.searchParams.get("page"), "page") }
          : {}),
        ...(optionalPositiveInt(url.searchParams.get("pageSize"), "pageSize")
          ? { pageSize: optionalPositiveInt(url.searchParams.get("pageSize"), "pageSize") }
          : {}),
      });
      sendJson(res, 200, page);
      return;
    }

    if (url.pathname === "/internal/v1/requirements/search" && method === "GET") {
      const page = await service.searchRequirements(actor.orgId, {
        ...(url.searchParams.get("query") ? { query: url.searchParams.get("query")! } : {}),
        ...(url.searchParams.get("priority") ? { priority: url.searchParams.get("priority")! } : {}),
        ...(optionalPositiveInt(url.searchParams.get("page"), "page")
          ? { page: optionalPositiveInt(url.searchParams.get("page"), "page") }
          : {}),
        ...(optionalPositiveInt(url.searchParams.get("pageSize"), "pageSize")
          ? { pageSize: optionalPositiveInt(url.searchParams.get("pageSize"), "pageSize") }
          : {}),
      });
      sendJson(res, 200, page);
      return;
    }

    if (url.pathname === "/internal/v1/trends" && method === "GET") {
      const days = optionalPositiveInt(url.searchParams.get("days"), "days") ?? 30;
      if (days > 365) throw new BridgeError(400, "BAD_REQUEST", "days 不能超过 365");
      sendJson(res, 200, await service.getTrendSummary(actor.orgId, days));
      return;
    }

    sendError(res, 404, "NOT_FOUND", "未找到路由");
  } catch (error) {
    if (error instanceof BridgeError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    if (error instanceof LegacyBackendError) {
      sendError(res, error.httpStatus, error.code, error.message);
      return;
    }
    sendError(res, 500, "INTERNAL_ERROR", "Bridge 内部错误");
  }
}

export function createBridgeServer(config: BridgeConfig, service: BridgeService): http.Server {
  const server = http.createServer((req, res) => void handle(req, res, config, service));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
