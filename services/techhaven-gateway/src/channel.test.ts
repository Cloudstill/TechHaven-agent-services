/**
 * EventChannel 纯域单测（node:test + tsx，无新增依赖）。
 *
 * 重点锁定并发语义——这些是 smoke 跑不到、但一退化就会「SSE 永久挂死 / 事件漏投」的不变量：
 *  - close 必须唤醒全部挂起 waiter，否则消费者卡死在 await；
 *  - push 与挂起之间无 await 间隙，否则丢事件；
 *  - 消费者提前退出必须摘除 waiter，否则句柄泄漏。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventChannel } from "./channel.js";
import { sleep } from "./util.js";

/** 让出事件循环若干轮，使挂起的 await 真正进入等待态 */
const tick = (): Promise<void> => sleep(0);

/** 白盒读取 waiter 队列长度：验证「提前退出不泄漏」这条实现不变量 */
function pendingWaiters(channel: EventChannel<unknown>): number {
  return (channel as unknown as { waiters: unknown[] }).waiters.length;
}

/** 从迭代器取满 n 项；提前 done 就停（不调 return，留给调用方决定） */
async function take<T>(it: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    const next = await it.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

test("replay=true：每次 iterate 都从 0 回放全量", async () => {
  const channel = new EventChannel<string>();
  channel.push("a");
  channel.push("b");

  assert.deepEqual(await take(channel.iterate({ replay: true })[Symbol.asyncIterator](), 2), ["a", "b"]);
  // 第二次 iterate 仍从 0 开始（dsh 的「可重复回放」依赖此语义）
  assert.deepEqual(await take(channel.iterate({ replay: true })[Symbol.asyncIterator](), 2), ["a", "b"]);
});

test("replay=false：游标跨 iterate 共享，只消费一次", async () => {
  const channel = new EventChannel<string>();
  channel.push("a");
  channel.push("b");

  assert.deepEqual(await take(channel.iterate({ replay: false })[Symbol.asyncIterator](), 2), ["a", "b"]);
  channel.push("c");
  // 上一段已推进到 2，本段只见到新增的 c
  assert.deepEqual(await take(channel.iterate({ replay: false })[Symbol.asyncIterator](), 1), ["c"]);
});

test("挂起中的消费者被 push 唤醒，不丢事件", async () => {
  const channel = new EventChannel<string>();
  const it = channel.iterate({ replay: true })[Symbol.asyncIterator]();

  channel.push("a");
  const first = await it.next();
  assert.deepEqual(first, { value: "a", done: false });

  const pending = it.next(); // 队列已空，在此挂起
  await tick();
  channel.push("b");
  // 关键：push 与挂起之间无 await 间隙，这里绝不能漏事件
  assert.deepEqual(await pending, { value: "b", done: false });

  await it.return?.();
});

test("close() 唤醒挂起 waiter，消费者消费完 archive 后正常收尾", async () => {
  const channel = new EventChannel<string>();
  channel.push("a");
  const it = channel.iterate({ replay: true })[Symbol.asyncIterator]();

  // 取 5 项但只有 1 项：必定挂起
  const pending = take(it, 5);
  await tick();
  channel.close();

  // 关键：不 close 这里会永久挂住
  assert.deepEqual(await pending, ["a"]);
});

test("close() 后再 push 为静默 no-op", async () => {
  const channel = new EventChannel<string>();
  channel.push("a");
  channel.close();
  channel.push("b");

  assert.deepEqual(await take(channel.iterate({ replay: true })[Symbol.asyncIterator](), 9), ["a"]);
});

test("空通道 + close：iterate 立即 done，不挂起", async () => {
  const channel = new EventChannel<string>();
  channel.close();
  const it = channel.iterate({ replay: true })[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("close() 幂等：重复调用不抛错也不重复唤醒", async () => {
  const channel = new EventChannel<string>();
  const it = channel.iterate({ replay: true })[Symbol.asyncIterator]();
  const pending = it.next();
  await tick();

  channel.close();
  channel.close();
  channel.close();

  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("多消费者各自收到全量事件（SSE 扇出不互相抢事件）", async () => {
  const channel = new EventChannel<number>();
  const itA = channel.iterate({ replay: true })[Symbol.asyncIterator]();
  const itB = channel.iterate({ replay: true })[Symbol.asyncIterator]();

  for (const n of [1, 2, 3]) channel.push(n);

  assert.deepEqual(await take(itA, 3), [1, 2, 3]);
  assert.deepEqual(await take(itB, 3), [1, 2, 3]);
  await itA.return?.();
  await itB.return?.();
});

test("for await 提前 break：生成器 finally 执行，通道无残留 waiter", async () => {
  const channel = new EventChannel<number>();
  for (const n of [1, 2, 3]) channel.push(n);

  const seen: number[] = [];
  // 在 yield 点退出（archive 还剩 2 项）：return() 可正常落地，finally 摘除逻辑生效
  for await (const value of channel.iterate({ replay: true })) {
    seen.push(value);
    if (seen.length === 1) break;
  }

  assert.deepEqual(seen, [1]);
  assert.equal(pendingWaiters(channel), 0);
});

test("close 唤醒全部挂起 waiter 并清空队列，无残留", async () => {
  const channel = new EventChannel<string>();
  const itA = channel.iterate({ replay: true })[Symbol.asyncIterator]();
  const itB = channel.iterate({ replay: true })[Symbol.asyncIterator]();

  const pendingA = itA.next();
  const pendingB = itB.next();
  await tick();
  assert.equal(pendingWaiters(channel), 2);

  channel.close();

  assert.deepEqual(await pendingA, { value: undefined, done: true });
  assert.deepEqual(await pendingB, { value: undefined, done: true });
  assert.equal(pendingWaiters(channel), 0);
});

test("push 唤醒后 waiter 即被消费，不残留到下一次挂起", async () => {
  const channel = new EventChannel<string>();
  const it = channel.iterate({ replay: true })[Symbol.asyncIterator]();

  const pending = it.next(); // 空队列 → 注册 waiter 后挂起
  await tick();
  assert.equal(pendingWaiters(channel), 1);

  channel.push("a");
  assert.deepEqual(await pending, { value: "a", done: false });
  assert.equal(pendingWaiters(channel), 0);

  await it.return?.();
});
