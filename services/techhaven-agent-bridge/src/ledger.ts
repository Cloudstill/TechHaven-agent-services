import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type OperationStatus = "started" | "confirmed" | "uncertain" | "failed";

export interface OperationRecord {
  idempotencyKey: string;
  requestDigest: string;
  sessionId: string;
  orgId: number;
  kind: string;
  subjectId: number;
  toStatus: string;
  status: OperationStatus;
  ts: string;
  note?: string;
}

export interface OperationLedger {
  get(idempotencyKey: string): OperationRecord | undefined;
  append(record: OperationRecord): void;
  close(): Promise<void>;
}

export class LedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCorruptionError";
  }
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.idempotencyKey === "string" &&
    typeof row.requestDigest === "string" &&
    typeof row.sessionId === "string" &&
    Number.isInteger(row.orgId) &&
    typeof row.kind === "string" &&
    Number.isInteger(row.subjectId) &&
    typeof row.toStatus === "string" &&
    ["started", "confirmed", "uncertain", "failed"].includes(String(row.status)) &&
    typeof row.ts === "string"
  );
}

/**
 * 单实例 append-only 幂等台账。只保存请求摘要与对象定位，不保存旧后端凭据、完整正文或 reason。
 * 多实例生产部署需要将此端口替换为带唯一键/行锁的数据库实现。
 */
export class JsonlOperationLedger implements OperationLedger {
  private readonly states = new Map<string, OperationRecord>();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.restore();
  }

  get(idempotencyKey: string): OperationRecord | undefined {
    return this.states.get(idempotencyKey);
  }

  append(record: OperationRecord): void {
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.states.set(record.idempotencyKey, record);
  }

  async close(): Promise<void> {}

  private restore(): void {
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let lineNumber = 0;
    for (const line of raw.split(/\r?\n/)) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isOperationRecord(value)) throw new Error("字段不完整");
        this.states.set(value.idempotencyKey, value);
      } catch (error) {
        throw new LedgerCorruptionError(
          `幂等台账 ${this.file} 第 ${lineNumber} 行损坏；为避免重复写入，Bridge 拒绝启动：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
