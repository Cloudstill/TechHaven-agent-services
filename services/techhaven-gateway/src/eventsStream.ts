import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayError, toEnvelopeJson, type SessionEventSubscriber, type SessionRecord, type SessionRegistry } from "./sessions.js";
import { log } from "./log.js";
const KEEPALIVE_MS = 15_000;
const MAX_PENDING_BYTES = 1024 * 1024;

export function handleEventsStream(
  req: IncomingMessage,
  url: URL,
  record: SessionRecord,
  registry: SessionRegistry,
  res: ServerResponse,
): void {
  const afterRaw = url.searchParams.get("after");
  let after = -1; // 默认全量补发（seq 从 1 起）
  if (afterRaw !== null) {
    const parsed = Number(afterRaw);
    if (!Number.isFinite(parsed)) throw new GatewayError(400, "查询参数 after 必须是数字");
    after = Math.trunc(parsed);
  } else {
    // 断线重连回放：缺省回读 Last-Event-ID（EventSource 重连自动携带最后收到的 id）；缺失 / 非数字按 -1 全量补发
    const lastId = req.headers["last-event-id"];
    const parsed = Number(Array.isArray(lastId) ? lastId[0] : lastId);
    after = Number.isFinite(parsed) ? Math.trunc(parsed) : -1;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // 提示反向代理不要缓冲事件流
    "x-accel-buffering": "no",
  });

  const writable = (): boolean => !res.destroyed && !res.writableEnded;
  // 最小背压：记录累计未冲刷字节数；write 返回 false 或超上限 → 断开慢客户端（事件已落 JSONL 不丢失）
  let pendingBytes = 0;
  res.on("drain", () => {
    pendingBytes = 0;
  });
  const writeFrame = (frame: string): void => {
    if (!writable()) return;
    pendingBytes += Buffer.byteLength(frame);
    const flushed = res.write(frame);
    if (!flushed || pendingBytes > MAX_PENDING_BYTES) {
      log(`SSE 订阅者背压超限（${record.sid}，pending=${pendingBytes}B），断开慢客户端`);
      res.destroy();
    }
  };

  // 1) 先补发 seq>after 的缓存事件，再订阅 —— 两步之间无 await，单线程下不会漏事件
  for (const ev of record.events) {
    if (ev.seq > after) writeFrame(`id: ${ev.seq}\ndata: ${toEnvelopeJson(record, ev)}\n\n`);
  }

  let closed = false;
  const keepalive = setInterval(() => {
    // 心跳只维持连接，不计入背压统计
    if (writable()) res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);
  keepalive.unref(); // 心跳不阻止进程退出（由活跃连接自身维持进程存活）

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    registry.unsubscribe(record, subscriber);
    if (writable()) {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    }
  };
  const subscriber: SessionEventSubscriber = {
    onEvent: (frame) => writeFrame(frame),
    onEnd: () => finish(),
  };
  registry.subscribe(record, subscriber);

  // 2) 客户端断连清理：取消订阅 + 停心跳（正常 finish 后 close 也会触发，closed 幂等）
  res.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    registry.unsubscribe(record, subscriber);
  });
}
