/** 研发平台领域类型（对齐 TechHaven src/types/rdPlatform.ts 的枚举） */

export type TicketKind = "requirement" | "bug" | "task";

export type RequirementStatus = "new" | "developing" | "testing" | "done" | "closed";
export type BugStatus = "new" | "accepted" | "processing" | "verified" | "closed" | "reopened";
export type TaskStatus = "todo" | "doing" | "done" | "closed";
export type TicketStatus = RequirementStatus | BugStatus | TaskStatus;

export interface TicketRecord {
  id: number;
  kind: TicketKind;
  orgId: number;
  title: string;
  description: string;
  status: TicketStatus;
  priority: string;
  assignee: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketPage {
  total: number;
  page: number;
  pageSize: number;
  items: TicketRecord[];
}

export interface TrendSummary {
  orgId: number;
  days: number;
  /** 每类工单的存量 open / closed / total */
  byKind: Record<TicketKind, { open: number; closed: number; total: number }>;
  /** 窗口内新建数量 */
  newlyCreated: number;
  /** 窗口内关闭数量（status === "closed" 且 updatedAt 在窗口内） */
  newlyClosed: number;
}
