import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertTransition, canTransition, IllegalTransitionError } from "./stateMachine.js";
import type { TicketKind, TicketStatus } from "./types.js";

describe("工单状态机", () => {
  describe("requirement", () => {
    it("允许 new → developing", () => {
      assert.equal(canTransition("requirement", "new", "developing"), true);
    });

    it("允许 testing → developing（测试打回）", () => {
      assert.equal(canTransition("requirement", "testing", "developing"), true);
    });

    it("拒绝 new → done（跨阶段跳跃）", () => {
      assert.equal(canTransition("requirement", "new", "done"), false);
    });

    it("closed 是终态，无任何出边", () => {
      const targets: TicketStatus[] = ["new", "developing", "testing", "done", "closed"];
      for (const to of targets) {
        assert.equal(canTransition("requirement", "closed", to), false, `requirement closed → ${to} 不应允许`);
      }
    });
  });

  describe("bug", () => {
    it("允许 new → accepted", () => {
      assert.equal(canTransition("bug", "new", "accepted"), true);
    });

    it("允许 verified → closed 与 closed → reopened", () => {
      assert.equal(canTransition("bug", "verified", "closed"), true);
      assert.equal(canTransition("bug", "closed", "reopened"), true);
    });

    it("拒绝 processing → closed（未经 verified）", () => {
      assert.equal(canTransition("bug", "processing", "closed"), false);
    });
  });

  describe("task", () => {
    it("允许 todo ↔ doing 双向", () => {
      assert.equal(canTransition("task", "todo", "doing"), true);
      assert.equal(canTransition("task", "doing", "todo"), true);
    });

    it("拒绝 done → doing（回退）", () => {
      assert.equal(canTransition("task", "done", "doing"), false);
    });
  });

  describe("非法输入与错误类型", () => {
    it("未知起始状态一律拒绝，不抛异常", () => {
      assert.equal(canTransition("task", "nonexistent" as TicketStatus, "doing"), false);
    });

    it("assertTransition 在非法迁移时抛出 IllegalTransitionError", () => {
      // bug new 只能到 accepted / closed；直接跳到 verified 非法
      assert.throws(
        () => assertTransition("bug", "new", "verified"),
        (error: unknown) => error instanceof IllegalTransitionError && /非法状态迁移/.test((error as Error).message),
      );
    });

    it("assertTransition 在合法迁移时不抛异常", () => {
      assert.doesNotThrow(() => assertTransition("task", "todo", "doing"));
    });

    it("每种工单类型的终态集合符合契约", () => {
      const terminal: Record<TicketKind, TicketStatus[]> = {
        requirement: ["closed"],
        bug: [],
        task: ["closed"],
      };
      for (const kind of Object.keys(terminal) as TicketKind[]) {
        for (const status of terminal[kind]) {
          const anyOut = (
            [
              "new",
              "developing",
              "testing",
              "done",
              "closed",
              "todo",
              "doing",
              "accepted",
              "processing",
              "verified",
              "reopened",
            ] as TicketStatus[]
          ).some((to) => canTransition(kind, status, to));
          assert.equal(anyOut, false, `${kind} 的 ${status} 应为终态`);
        }
      }
    });
  });
});
