import type { TicketKind, TicketStatus } from "./types.js";

/**
 * 工单状态机（TH-RFC-001 §05.3：非法迁移一律拒绝）。
 *
 * 状态枚举对齐 TechHaven 前端 src/types/rdPlatform.ts：
 *   requirement: new | developing | testing | done | closed
 *   bug:         new | accepted | processing | verified | reopened | closed
 *   task:        todo | doing | done | closed
 *
 * TODO(对齐后端)：迁移规则需与朋友后端的行为核对后冻结（P0 验收项之一）。
 */
const TRANSITIONS: Record<TicketKind, Record<string, readonly TicketStatus[]>> = {
  requirement: {
    new: ["developing", "closed"],
    developing: ["testing", "closed"],
    testing: ["done", "developing"],
    done: ["closed"],
    closed: [],
  },
  bug: {
    new: ["accepted", "closed"],
    accepted: ["processing", "closed"],
    processing: ["verified", "reopened"],
    verified: ["closed"],
    reopened: ["processing", "closed"],
    closed: ["reopened"],
  },
  task: {
    todo: ["doing", "closed"],
    doing: ["done", "todo"],
    done: ["closed"],
    closed: [],
  },
};

export class IllegalTransitionError extends Error {
  constructor(kind: TicketKind, from: string, to: string) {
    super(`非法状态迁移：${kind} 不能从 ${from} 变更为 ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(kind: TicketKind, from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[kind][from]?.includes(to) ?? false;
}

export function assertTransition(kind: TicketKind, from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(kind, from, to)) {
    throw new IllegalTransitionError(kind, from, to);
  }
}
