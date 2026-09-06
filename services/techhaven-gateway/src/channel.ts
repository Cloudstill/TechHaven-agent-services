/**
 * 通用事件通道（零依赖）：push / close / iterate 的单一 AsyncIterable 实现。
 * 收敛此前 drivers/mock（EventQueue）与 drivers/dsh（EventChannel）各自手写的孪生队列，防漂移。
 *
 * 语义：
 *  - archive 保存全部事件体；
 *  - iterate({ replay: true }) 每次 iterate 从 0 回放（多消费者各得全量，dsh 的"可重复回放"用此）；
 *    iterate({ replay: false }) 用跨 iterate 共享的单趟游标（只消费一次时与回放等价，mock 用此）；
 *  - close() 后 push() 为受保护 no-op（取消 / 释放竞态下的迟到事件静默丢弃）；
 *    close() 唤醒全部挂起 waiter 使其立即返回 done —— 否则消费者会在 await 处永久卡死；
 *  - waiter 在消费端 finally 中摘除：消费者提前退出（break / 异常 / return）不泄漏。
 *
 * ⚠️ 挂起语义（2026-08-29 单测确认，勿想当然）：
 *  消费者若正挂起在内部 await 上（archive 已排空且通道未关），调用 iterator.return() **不会落地**——
 *  按 AsyncGenerator 规范，return 请求要排队到生成器体让出控制权后才处理，而让出的唯一途径是
 *  内部 promise resolve（即 push 或 close）。此时 finally 不会运行，waiter 也不会被摘除。
 *  因此：**终止消费的唯一可靠路径是 channel.close()**，不要指望 return() 能取消一个挂起的消费者。
 *  finally 里的 waiter 摘除只在消费者处于 yield 点（for await 内 break / 抛异常）时才真正生效，
 *  那种情况下本来就没有 waiter 注册——它是兜底而非主路径。
 *  现有调用方（drivers/mock、drivers/dsh 的 dispose）走的都是 close()，与此语义一致。
 */
export class EventChannel<T> {
  private readonly archive: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  /** replay=false 的单趟游标（跨 iterate 共享，只前进） */
  private readCursor = 0;

  /** 推入事件体；close 后静默丢弃 */
  push(body: T): void {
    if (this.closed) return;
    this.archive.push(body);
    this.wake();
  }

  /** 结束事件流：唤醒全部挂起的 iterate，使其在消费完 archive 后正常收尾 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** 消费端迭代器：先回放 / 排空 archive，再挂起等待新事件 */
  async *iterate(opts: { replay: boolean }): AsyncIterable<T> {
    let waiter: (() => void) | undefined;
    // replay=true：每次从 0 回放；replay=false：接续共享单趟游标（单消费者下与回放等价）
    let cursor = opts.replay ? 0 : this.readCursor;
    try {
      for (;;) {
        if (cursor < this.archive.length) {
          const body = this.archive[cursor];
          cursor += 1;
          if (!opts.replay) this.readCursor = Math.max(this.readCursor, cursor);
          yield body;
          continue;
        }
        if (this.closed) return;
        // 检查 archive 与挂起等待之间无 await，不会漏掉并发 push
        await new Promise<void>((resolve) => {
          waiter = () => {
            waiter = undefined;
            resolve();
          };
          this.waiters.push(waiter);
        });
      }
    } finally {
      // 消费者提前退出（break / 异常 / return）时摘除挂起的 waiter，避免泄漏
      if (waiter) {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
      }
    }
  }
}
