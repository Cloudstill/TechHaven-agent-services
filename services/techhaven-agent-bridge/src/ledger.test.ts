import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlOperationLedger, LedgerCorruptionError, type OperationRecord } from "./ledger.js";

const RECORD: OperationRecord = {
  idempotencyKey: "p_1",
  requestDigest: "a".repeat(64),
  sessionId: "s_1",
  orgId: 1,
  kind: "bug",
  subjectId: 7,
  toStatus: "accepted",
  status: "started",
  ts: "2026-08-31T00:00:00.000Z",
};

test("台账记录可在重启后恢复", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "operations.jsonl");

  new JsonlOperationLedger(file).append(RECORD);

  assert.deepEqual(new JsonlOperationLedger(file).get("p_1"), RECORD);
});

test("台账损坏时拒绝启动，不能把未知操作当成新写入", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-bridge-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "operations.jsonl");
  writeFileSync(file, `${JSON.stringify(RECORD)}\n{broken-json\n`, "utf8");

  assert.throws(() => new JsonlOperationLedger(file), LedgerCorruptionError);
});
