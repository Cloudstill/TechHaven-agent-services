import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayError } from "./sessions.js";
import { isRecord } from "./util.js";
const MAX_BODY_BYTES = 1024 * 1024;

/** 读取并解析 JSON 请求体（限 1MB，空体返回 undefined） */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new GatewayError(413, "请求体超过 1MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new GatewayError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 请求体必须是 JSON 对象（POST 路由共用校验） */
export function jsonObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new GatewayError(400, "请求体必须是 JSON 对象");
  return body;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    throw new GatewayError(400, `缺少必填字段：${key}`);
  }
  if (typeof value !== "string") throw new GatewayError(400, `字段 ${key} 必须是字符串`);
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new GatewayError(400, `字段 ${key} 必须是字符串`);
  return value;
}

/** 审批主体由持有 Gateway 内部令牌的 BFF/开发代理注入，禁止从 JSON body 接受可伪造 actor。 */
export function trustedActor(req: IncomingMessage): string {
  const raw = req.headers["x-techhaven-actor"];
  const actor = Array.isArray(raw) ? raw[0] : raw;
  if (typeof actor !== "string" || !/^user:[1-9]\d*$/.test(actor.trim())) {
    throw new GatewayError(401, "缺少可信审批主体 X-TechHaven-Actor（格式 user:<positive-id>）");
  }
  return actor.trim();
}
