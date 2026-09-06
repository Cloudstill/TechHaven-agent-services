import test from "node:test";
import assert from "node:assert/strict";
import { renderPrometheus } from "./metrics.js";
import type { SessionRecord } from "./sessions.js";

function record(status: SessionRecord["status"], subscribers = 0, events = 0): SessionRecord {
  return {
    sid: `s_${status}`,
    orgId: 1,
    prompt: "p",
    status,
    createdAt: "2026-09-04T00:00:00.000Z",
    events: Array.from({ length: events }, (_, i) => ({
      seq: i + 1,
      ts: "2026-09-04T00:00:00.000Z",
      type: "assistant_chunk" as const,
      payload: {},
    })),
    subscribers: new Set(Array.from({ length: subscribers }, () => ({}))),
  } as unknown as SessionRecord;
}

test("输出包含进程级指标", () => {
  const text = renderPrometheus({
    driver: "mock",
    store: "jsonl",
    sessions: [],
    uptimeSeconds: 12.3456,
    memoryBytes: { rss: 1000, heapUsed: 500 },
  });
  assert.match(text, /techhaven_gateway_uptime_seconds 12\.346/);
  assert.match(text, /techhaven_process_memory_rss_bytes 1000/);
  assert.match(text, /# TYPE techhaven_gateway_uptime_seconds gauge/);
});

test("按状态聚合会话，并汇总订阅与缓存事件", () => {
  const text = renderPrometheus({
    driver: "mock",
    store: "jsonl",
    sessions: [
      record("running", 2, 10),
      record("running", 1, 5),
      record("failed", 0, 3),
      record("succeeded", 0, 7),
    ],
    uptimeSeconds: 1,
    memoryBytes: { rss: 0, heapUsed: 0 },
  });
  assert.match(text, /techhaven_sessions\{status="running"\} 2/);
  assert.match(text, /techhaven_sessions\{status="failed"\} 1/);
  assert.match(text, /techhaven_sessions\{status="queued"\} 0/, "空状态也要显式输出 0，便于告警判空");
  assert.match(text, /techhaven_sse_subscribers 3/);
  assert.match(text, /techhaven_session_events_cached 25/);
});
