import type { SessionRecord } from "./sessions.js";

/**
 * 最小可观测：Prometheus 文本格式（零依赖）。
 * 暴露：进程存活时间/内存、按状态会话数、SSE 订阅数、缓存事件数。
 * 由 http.ts 的 /metrics 路由使用（与普通接口同 Bearer 鉴权，避免身份泄露）。
 */

export interface MetricsSnapshot {
  driver: string;
  store: string;
  sessions: readonly SessionRecord[];
  uptimeSeconds: number;
  memoryBytes: { rss: number; heapUsed: number };
}

const SESSION_STATUSES = ["queued", "running", "awaiting_permission", "succeeded", "failed", "cancelled"] as const;

export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  const gauge = (name: string, help: string, value: number, labels = ""): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels ? `{${labels}}` : ""} ${value}`);
  };

  gauge("techhaven_gateway_uptime_seconds", "Gateway process uptime", Number(snapshot.uptimeSeconds.toFixed(3)));
  gauge("techhaven_process_memory_rss_bytes", "Process resident memory", snapshot.memoryBytes.rss);
  gauge("techhaven_process_memory_heap_used_bytes", "Process heap used", snapshot.memoryBytes.heapUsed);

  const byStatus = new Map<string, number>();
  for (const status of SESSION_STATUSES) byStatus.set(status, 0);
  let subscribers = 0;
  let cachedEvents = 0;
  for (const session of snapshot.sessions) {
    byStatus.set(session.status, (byStatus.get(session.status) ?? 0) + 1);
    subscribers += session.subscribers.size;
    cachedEvents += session.events.length;
  }
  for (const status of SESSION_STATUSES) {
    gauge("techhaven_sessions", "Sessions held in registry by status", byStatus.get(status) ?? 0, `status="${status}"`);
  }
  gauge("techhaven_sse_subscribers", "Active SSE subscribers across sessions", subscribers);
  gauge("techhaven_session_events_cached", "Engine events cached in memory", cachedEvents);

  return lines.join("\n") + "\n";
}
