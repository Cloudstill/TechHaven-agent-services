import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalStore } from "./store.js";

/**
 * 审查意见 F2 负向测试：applyApproved 与人工撤回交错时的状态约束。
 * 旧实现：applyApproved 读到 approved 后先执行业务写回调，回调返回才追加 applied；
 *         期间 Gateway 可把状态推到 rejected，回调成功后业务写入已发生。
 * 新实现：applyApproved 真正领取时先落 applying，进入互斥段；
 *         applying 期间非系统侧的人工撤回必须失败（"无法撤回"）；
 *         业务写成功 → applied；异常 → system rejected + 抛错。
 */

function makeStore(): { dir: string; store: ProposalStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "techhaven-mcp-proposals-"));
  const store = new ProposalStore(join(dir, "proposals.jsonl"), 30);
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sampleDetail() {
  return {
    sessionId: "s_1",
    orgId: 1,
    tool: "update_ticket_status",
    kind: "bug" as const,
    subjectHashId: "b_x",
    subjectId: 1,
    fromStatus: "new",
    toStatus: "accepted",
    reason: "复现稳定",
  };
}

test("F2 · approved → applying → applied；撤回后再无 rejected 残余", () => {
  const { store, cleanup } = makeStore();
  try {
    const detail = store.create(sampleDetail());
    store.appendEvent("approved", detail.id, "user:cli");
    assert.equal(store.getState(detail.id).status, "approved");

    // 同步 applyApproved：内置 apply callback 直接返回 applied
    let resolved = false;
    return store
      .applyApproved(detail.id, async () => {
        resolved = true;
        return { status: "applied" };
      })
      .then((claimed) => {
        assert.equal(claimed, true);
        assert.equal(resolved, true);
        // 终态：applied（不再有 rejected 事件）
        assert.equal(store.getState(detail.id).status, "applied");
      })
      .finally(cleanup);
  } catch (e) {
    cleanup();
    throw e;
  }
});

test("F2 · applying 期间人工撤回必须失败（无法撤回）", async () => {
  const { store, cleanup } = makeStore();
  try {
    const detail = store.create(sampleDetail());
    store.appendEvent("approved", detail.id, "user:cli");

    // 释义：applyApproved 立即落 applying 之前，业务写回调用 gate 等外部信号
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applyPromise = store.applyApproved(detail.id, async () => {
      await gate;
      return { status: "applied" };
    });

    // 等一帧让 apply 落 applying（store 是同步文件 IO，microtask 即可）
    await new Promise((r) => setImmediate(r));
    assert.equal(store.getState(detail.id).status, "applying", "applyApproved 应先落 applying");

    // 关键断言：applying 期间人工撤回必须报错，不会写入 rejected
    assert.throws(
      () => store.appendEvent("rejected", detail.id, "user:cli"),
      /正在应用.*无法撤回/,
      "applying 期间人工撤回应抛错",
    );

    // 业务写完成 → applied
    release();
    const claimed = await applyPromise;
    assert.equal(claimed, true);
    assert.equal(store.getState(detail.id).status, "applied");
  } finally {
    cleanup();
  }
});

test("F2 · apply 异常走 system rejected，不允许业务写继续进行", async () => {
  const { store, cleanup } = makeStore();
  try {
    const detail = store.create(sampleDetail());
    store.appendEvent("approved", detail.id, "user:cli");

    await assert.rejects(
      () =>
        store.applyApproved(detail.id, async () => {
          throw new Error("旧后端 502");
        }),
      /旧后端 502/,
    );

    // apply 内部已 forceEvent("rejected", ..., "system")——终态不是 applying 悬挂
    assert.equal(store.getState(detail.id).status, "rejected");
  } finally {
    cleanup();
  }
});
