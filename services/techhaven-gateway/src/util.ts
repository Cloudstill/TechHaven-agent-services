/**
 * 共享零依赖工具（gateway 内部收敛）：时间戳 / 错误文案 / 睡眠 / 结构判别 / 稳定摘要。
 * 取代此前散落在 sessions / drivers/mock / drivers/dsh 的各份本地孪生实现，防漂移。
 */
import { createHash } from "node:crypto";

/** 当前时刻（ISO 8601） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 错误的统一文案：Error 取 message，其余 String() */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 等待指定毫秒（0 也合法，便于测试提速） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 结构判别：非空普通对象（排除 null / 数组），用于校验外部 JSON 载荷 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * sha256(JSON.stringify(value ?? null)) 前 16 位 hex（工具入参 argsDigest 约定）。
 * 与 services/techhaven-mcp/src/audit.ts 的 sha256Digest 逐字同构（undefined 一律归一为
 * null 再序列化）——勿再造第三种 undefined 语义，两处需同步评审。
 */
export function sha256Hex16(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex").slice(0, 16);
}
