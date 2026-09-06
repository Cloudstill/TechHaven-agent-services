import { assertTransition } from "../domain/stateMachine.js";
import type { TicketKind, TicketPage, TicketRecord, TrendSummary } from "../domain/types.js";
import { DomainError, type TechHavenClient } from "./client.js";

/** 演示数据：org 1 下 3 需求 + 3 缺陷 + 2 任务。仅用于 P0 离线 PoC。 */

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}

function iso(d: Date): string {
  return d.toISOString();
}

interface Seed {
  id: number;
  kind: TicketKind;
  title: string;
  description: string;
  status: TicketRecord["status"];
  priority: string;
  assignee: string;
  creator: string;
  createdDaysAgo: number;
  updatedDaysAgo: number;
}

const SEEDS: Seed[] = [
  {
    id: 1,
    kind: "requirement",
    title: "文章编辑器支持 Mermaid 图表导出为 PNG",
    description: "编辑器内 Mermaid 预览已可用，需要增加导出能力，方便文章插图与作业报告使用。",
    status: "new",
    priority: "high",
    assignee: "chen",
    creator: "chen",
    createdDaysAgo: 3,
    updatedDaysAgo: 3,
  },
  {
    id: 2,
    kind: "requirement",
    title: "研发看板趋势数据支持 CSV 导出",
    description: "趋势分析页增加导出按钮，按时间窗导出聚合结果。",
    status: "developing",
    priority: "medium",
    assignee: "dev01",
    creator: "chen",
    createdDaysAgo: 12,
    updatedDaysAgo: 2,
  },
  {
    id: 3,
    kind: "requirement",
    title: "组织作业模块移动端适配",
    description: "作业发布与提交页在小屏下的布局适配。",
    status: "testing",
    priority: "low",
    assignee: "dev02",
    creator: "dev01",
    createdDaysAgo: 25,
    updatedDaysAgo: 5,
  },
  {
    id: 1,
    kind: "bug",
    title: "KaTeX 公式在暗色主题下对比度不足",
    description: "暗色主题下行内公式颜色继承正文色，部分符号几乎不可见。复现：暗色主题打开含公式的文章。",
    status: "new",
    priority: "urgent",
    assignee: "",
    creator: "dev02",
    createdDaysAgo: 1,
    updatedDaysAgo: 1,
  },
  {
    id: 2,
    kind: "bug",
    title: "分片上传中断后无法断点续传",
    description: "网络波动导致上传中断后重试从头开始，期望按分片续传。",
    status: "accepted",
    priority: "high",
    assignee: "chen",
    creator: "dev01",
    createdDaysAgo: 8,
    updatedDaysAgo: 4,
  },
  {
    id: 3,
    kind: "bug",
    title: "WebSocket 重连后通知重复弹窗",
    description: "指数退避重连成功后，未读通知被重复投递，message 连续弹出两次。",
    status: "processing",
    priority: "medium",
    assignee: "dev01",
    creator: "chen",
    createdDaysAgo: 20,
    updatedDaysAgo: 1,
  },
  {
    id: 1,
    kind: "task",
    title: "升级 Vite 至 8.1 并验证构建产物",
    description: "升级构建链，确认 dist 产物体积与 Sourcemap 正常。",
    status: "todo",
    priority: "medium",
    assignee: "chen",
    creator: "chen",
    createdDaysAgo: 6,
    updatedDaysAgo: 6,
  },
  {
    id: 2,
    kind: "task",
    title: "为评论树组件补充边界用例",
    description: "深层嵌套、删除中间节点、折叠态三个场景补进 sample 测试页。",
    status: "doing",
    priority: "low",
    assignee: "dev02",
    creator: "dev01",
    createdDaysAgo: 15,
    updatedDaysAgo: 2,
  },
];

const seeds: TicketRecord[] = SEEDS.map((s) => ({
  id: s.id,
  kind: s.kind,
  orgId: 1,
  title: s.title,
  description: s.description,
  status: s.status,
  priority: s.priority,
  assignee: s.assignee,
  creator: s.creator,
  createdAt: iso(daysAgo(s.createdDaysAgo)),
  updatedAt: iso(daysAgo(s.updatedDaysAgo)),
}));

export class MockTechHavenClient implements TechHavenClient {
  private all(): TicketRecord[] {
    return seeds;
  }

  async getTicket(orgId: number, kind: TicketKind, id: number): Promise<TicketRecord | null> {
    const found = this.all().find((t) => t.kind === kind && t.id === id && t.orgId === orgId);
    return found ?? null;
  }

  async listTickets(
    orgId: number,
    opts: { kind?: TicketKind; status?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 50);
    const page = Math.max(opts.page ?? 1, 1);
    const filtered = this.all().filter(
      (t) => t.orgId === orgId && (!opts.kind || t.kind === opts.kind) && (!opts.status || t.status === opts.status),
    );
    const start = (page - 1) * pageSize;
    return { total: filtered.length, page, pageSize, items: filtered.slice(start, start + pageSize) };
  }

  async searchRequirements(
    orgId: number,
    opts: { query?: string; priority?: string; page?: number; pageSize?: number },
  ): Promise<TicketPage> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 50);
    const page = Math.max(opts.page ?? 1, 1);
    const q = opts.query?.trim().toLowerCase();
    const filtered = this.all().filter(
      (t) =>
        t.orgId === orgId &&
        t.kind === "requirement" &&
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) &&
        (!opts.priority || t.priority === opts.priority),
    );
    const start = (page - 1) * pageSize;
    return { total: filtered.length, page, pageSize, items: filtered.slice(start, start + pageSize) };
  }

  async getTrendSummary(orgId: number, days: number): Promise<TrendSummary> {
    const since = Date.now() - days * 86400_000;
    const inOrg = this.all().filter((t) => t.orgId === orgId);
    const byKind = {
      requirement: { open: 0, closed: 0, total: 0 },
      bug: { open: 0, closed: 0, total: 0 },
      task: { open: 0, closed: 0, total: 0 },
    };
    let newlyCreated = 0;
    let newlyClosed = 0;
    for (const t of inOrg) {
      const bucket = byKind[t.kind];
      bucket.total += 1;
      if (t.status === "closed") bucket.closed += 1;
      else bucket.open += 1;
      if (Date.parse(t.createdAt) >= since) newlyCreated += 1;
      if (t.status === "closed" && Date.parse(t.updatedAt) >= since) newlyClosed += 1;
    }
    return { orgId, days, byKind, newlyCreated, newlyClosed };
  }

  async updateTicketStatus(
    orgId: number,
    kind: TicketKind,
    id: number,
    toStatus: string,
    _reason: string,
    _options?: { idempotencyKey?: string },
  ): Promise<TicketRecord> {
    const found = await this.getTicket(orgId, kind, id);
    if (!found) {
      throw new DomainError("NOT_FOUND", `未找到 ${kind} #${id}（组织 ${orgId}）`);
    }
    assertTransition(kind, found.status, toStatus as TicketRecord["status"]);
    found.status = toStatus as TicketRecord["status"];
    found.updatedAt = new Date().toISOString();
    return found;
  }
}
