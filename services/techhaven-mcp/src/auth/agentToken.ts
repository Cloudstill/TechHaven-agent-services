import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * agent token（TH-RFC-001 §05.2 的 P0 最小实现）
 *
 * - 格式：thm_v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)>
 * - 绑定：单会话（sid）+ 单组织（org）+ 读写分离 scope + 短时效（exp）
 * - P1 起由 Agent Gateway 签发；P0 用 `npm run token -- issue` 手动签发
 */

export const READ_SCOPE = "rd:read";
export const WRITE_SCOPE = "rd:write";
export type Scope = typeof READ_SCOPE | typeof WRITE_SCOPE;

export interface AgentTokenPayload {
  v: 1;
  /** 会话 ID：agent token 绑定单次 agent 会话 */
  sid: string;
  /** 组织 ID：所有工具调用限定在该组织内 */
  org: number;
  scopes: Scope[];
  /** 签发时间（epoch 秒） */
  iat: number;
  /** 过期时间（epoch 秒） */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAgentToken(payload: AgentTokenPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = hmac(body, secret);
  return `thm_v1.${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: AgentTokenPayload }
  | { ok: false; reason: string };

export function verifyAgentToken(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "thm_v1") {
    return { ok: false, reason: "token 格式不正确（期望 thm_v1.<payload>.<sig>）" };
  }
  const [, body, sig] = parts;

  const expected = hmac(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "签名校验失败" };
  }

  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AgentTokenPayload;
  } catch {
    return { ok: false, reason: "payload 无法解析" };
  }

  if (payload.v !== 1) return { ok: false, reason: "不支持的 token 版本" };
  if (!payload.sid || typeof payload.sid !== "string") return { ok: false, reason: "缺少会话 ID（sid）" };
  if (!Number.isFinite(payload.org) || payload.org <= 0) return { ok: false, reason: "缺少有效组织（org）" };
  if (!Array.isArray(payload.scopes) || payload.scopes.length === 0) {
    return { ok: false, reason: "缺少 scope" };
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: "token 已过期" };
  }
  return { ok: true, payload };
}

/** 解析 TTL 字符串（如 30m / 2h / 1d）为秒 */
export function parseTtl(text: string): number {
  const m = /^(\d+)([mhd])$/.exec(text.trim());
  if (!m) throw new Error(`无法解析 TTL：${text}（示例：30m / 2h / 1d）`);
  const unit = { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
