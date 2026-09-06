import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

/** 审计条目（TH-RFC-001 §07：append-only，每次工具调用一条） */
export interface AuditEntry {
  ts: string;
  session: string;
  org: number;
  actor: "agent";
  tool: string;
  /** 参数摘要（SHA-256，不落原始参数，避免敏感内容进日志） */
  argsDigest: string;
  decision: "allow" | "deny";
  reason?: string;
  latencyMs: number;
}

export function sha256Digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

/** DB 双写 sink 的最小接口（定义在此避免与具体实现相互依赖） */
export interface AuditSinkLike {
  append(entry: AuditEntry): Promise<void>;
}

export class AuditLog {
  constructor(
    private file: string,
    private db?: AuditSinkLike,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(entry: AuditEntry): void {
    try {
      appendFileSync(this.file, JSON.stringify(entry) + "\n", { encoding: "utf8" });
    } catch (err) {
      // 审计失败不能中断工具调用，但要留痕到 stderr
      log("审计写入失败:", err);
    }
    // DB 双写（可选）：JSONL 是权威来源，这里 fire-and-forget，失败只记 stderr
    this.db?.append(entry).catch((err) => log("DB 审计写入失败:", err));
  }
}
