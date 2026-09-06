import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_SCOPE, WRITE_SCOPE, type AgentTokenPayload, type Scope } from "../auth/agentToken.js";
import { assertTransition, IllegalTransitionError } from "../domain/stateMachine.js";
import type { TicketKind, TicketPage, TicketRecord, TicketStatus, TrendSummary } from "../domain/types.js";
import { DomainError, type TechHavenClient } from "../techhaven/client.js";
import { sha256Digest, type AuditLog } from "../audit.js";
import { decodeId, encodeId, type HashIdScope } from "../hashid.js";
import type { SemanticsProvider } from "../semantics/types.js";
import type { ProposalRepository } from "../proposals/store.js";

export interface ToolContext {
  client: TechHavenClient;
  session: AgentTokenPayload;
  audit: AuditLog;
  /** 语义层：提供字段业务含义与指标口径（供 get_semantics 读取） */
  semantics: SemanticsProvider;
  /** 写提案存储（staged 写模式使用；direct 模式不触碰） */
  proposals: ProposalRepository;
  /** 写模式：direct=直接生效（P0 现状）；staged=写操作先建提案等待人工批准（TH-RFC-001 §07） */
  writeMode: "direct" | "staged";
  /** 分级审批清单（TECHHAVEN_WRITE_STAGED_TOOLS）：staged 模式下仅列出的写工具走提案；
   *  未列入的写工具即使 staged 模式也直写（只读工具一律免审） */
  stagedTools: string[];
}

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 出参 ID 一律经 hashId 编码（防枚举），对齐 TechHaven 前端编码 */
function ticketSummary(t: TicketRecord) {
  return {
    id: encodeId(t.id, t.kind),
    kind: t.kind,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee || "(未指派)",
    updatedAt: t.updatedAt,
  };
}

function ticketDetail(t: TicketRecord) {
  return { ...ticketSummary(t), description: t.description, creator: t.creator, createdAt: t.createdAt };
}

function pageOut(p: TicketPage) {
  return { total: p.total, page: p.page, pageSize: p.pageSize, items: p.items.map(ticketSummary) };
}

const KINDS = ["requirement", "bug", "task"] as const;
const KIND_DESC = "工单类型：requirement=需求 | bug=缺陷 | task=任务";

/**
 * 统一守卫：scope 校验 → 审计（allow/deny 各一条，含参数摘要与耗时）→ 执行。
 * 设计依据：TH-RFC-001 §05.2（读写分离 scope）、§07（审计）。
 */
async function guard(
  ctx: ToolContext,
  tool: string,
  need: Scope | null,
  args: unknown,
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  const started = Date.now();
  const base = {
    ts: new Date().toISOString(),
    session: ctx.session.sid,
    org: ctx.session.org,
    actor: "agent" as const,
    tool,
    argsDigest: sha256Digest(args),
  };

  if (need && !ctx.session.scopes.includes(need)) {
    ctx.audit.append({ ...base, decision: "deny", reason: `缺少 scope ${need}`, latencyMs: 0 });
    return err(`权限不足：本次会话缺少 ${need} scope，无法调用 ${tool}`);
  }

  try {
    const out = await fn();
    ctx.audit.append({ ...base, decision: "allow", latencyMs: Date.now() - started });
    return ok(out);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "执行异常";
    ctx.audit.append({ ...base, decision: "allow", reason, latencyMs: Date.now() - started });
    if (e instanceof DomainError || e instanceof IllegalTransitionError) {
      return err(reason);
    }
    throw e; // 非预期错误交给 MCP 层
  }
}

/** P0 工具目录：6 读 + 1 写（含语义层读取 get_semantics，TH-RFC-001 §05.3）。写工具在 staged 模式下走提案审批流（§07）。add_ticket_comment / create_bug 属 P1。 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const org = ctx.session.org;

  server.registerTool(
    "get_ticket",
    {
      title: "获取工单详情",
      description: "读取一张工单（需求/缺陷/任务）的完整内容。需要 rd:read。",
      inputSchema: {
        kind: z.enum(KINDS).describe(KIND_DESC),
        id: z.string().describe("工单 hashId（其他工具返回的 id 字段，不可自行构造）"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "get_ticket", READ_SCOPE, args, async () => {
        const rec = await ctx.client.getTicket(org, args.kind, requireNumericId(args.id, args.kind));
        return rec ? ticketDetail(rec) : { notFound: true, kind: args.kind, id: args.id };
      }),
  );

  server.registerTool(
    "list_my_tickets",
    {
      title: "列出组织工单",
      description: "列出当前 agent 所属组织的工单（可按类型与状态过滤，单页上限 50）。需要 rd:read。",
      inputSchema: {
        kind: z
          .enum(KINDS)
          .optional()
          .describe(KIND_DESC + "；不传=全部类型"),
        status: z.string().optional().describe("按状态过滤（如 new / processing / doing）"),
        page: z.number().int().min(1).optional().describe("页码，默认 1"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "list_my_tickets", READ_SCOPE, args, async () =>
        pageOut(
          await ctx.client.listTickets(org, {
            kind: args.kind as TicketKind | undefined,
            status: args.status,
            page: args.page,
            pageSize: 20,
          }),
        ),
      ),
  );

  server.registerTool(
    "search_requirements",
    {
      title: "搜索需求",
      description: "按关键词与优先级搜索本组织需求。需要 rd:read。",
      inputSchema: {
        query: z.string().optional().describe("标题/描述关键词"),
        priority: z.enum(["high", "medium", "low"]).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "search_requirements", READ_SCOPE, args, async () =>
        pageOut(
          await ctx.client.searchRequirements(org, {
            query: args.query,
            priority: args.priority,
            page: args.page,
            pageSize: 20,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_trend_summary",
    {
      title: "获取趋势摘要",
      description: "本组织近 N 天研发趋势摘要（各类型 open/closed 计数、窗口内新建/关闭数）。需要 rd:read。",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe("时间窗天数，默认 30"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "get_trend_summary", READ_SCOPE, args, async () => {
        const summary: TrendSummary = await ctx.client.getTrendSummary(org, args.days ?? 30);
        return summary;
      }),
  );

  server.registerTool(
    "update_ticket_status",
    {
      title: "变更工单状态",
      description:
        "将工单变更为目标状态（须为合法迁移，非法迁移会被拒绝），必须说明原因。需要 rd:write。" +
        "direct 模式（默认）直接生效；staged 模式且本工具列入分级审批清单时，变更先存为提案" +
        "（pending，带过期时间），人工批准后由服务端 proposal worker 重新校验并幂等应用；get_proposal 只负责查询；" +
        "staged 但未列入清单则与 direct 相同直接生效。",
      inputSchema: {
        kind: z.enum(KINDS).describe(KIND_DESC),
        id: z.string().describe("工单 hashId"),
        to_status: z.string().min(1).describe("目标状态（如 accepted / processing / done / closed）"),
        reason: z.string().min(4).describe("变更原因（会写入审计与工单轨迹）"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      guard(ctx, "update_ticket_status", WRITE_SCOPE, args, async () => {
        // 分级审批：只读免审、列入清单的写工具走提案，未列入的写工具即使 staged 模式也直写
        // （为 P2 工具目录治理铺路：tool_catalog.org_tool_policy 就位后此清单改由 org_tool_policy 驱动）
        if (ctx.writeMode === "staged" && ctx.stagedTools.includes("update_ticket_status")) {
          return stageTicketStatusChange(ctx, org, args);
        }
        // direct 模式（或 staged 但本工具未列入审批清单）：行为与 P0 保持完全一致
        const rec = await ctx.client.updateTicketStatus(
          org,
          args.kind,
          requireNumericId(args.id, args.kind),
          args.to_status,
          args.reason,
        );
        return { updated: ticketDetail(rec) };
      }),
  );

  server.registerTool(
    "get_semantics",
    {
      title: "获取业务语义",
      description:
        "语义层读取：返回某类工单（需求/缺陷/任务）的字段业务含义（物理列名 → 业务名/含义/示例、敏感标记），" +
        "可选一并返回指标口径定义。agent 在查询或改数前应先调用本工具理解数据——从猜 schema 变查口径。需要 rd:read。",
      inputSchema: {
        kind: z.enum(KINDS).describe(KIND_DESC),
        include_metrics: z.boolean().optional().describe("是否一并返回指标口径，默认 false"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "get_semantics", READ_SCOPE, args, async () => {
        const object = await ctx.semantics.describeObject(args.kind);
        if (!object) {
          return { notFound: true, kind: args.kind };
        }
        return args.include_metrics ? { object, metrics: await ctx.semantics.listMetrics() } : { object };
      }),
  );

  // 放最后：它是 staged 写模式的配套查询（读工具），与 update_ticket_status 的 staged 分支配对
  server.registerTool(
    "get_proposal",
    {
      title: "查询提案状态",
      description:
        "staged 写模式下用它跟踪写提案：pending 表示变更未生效、等待人工批准；" +
        "人工批准后由服务端 worker 主动重校验并应用，本工具只查询状态，不触发写入。需要 rd:read。",
      inputSchema: {
        id: z.string().describe("提案 ID（update_ticket_status 在 staged 模式返回）"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(ctx, "get_proposal", READ_SCOPE, args, async () => {
        const state = await ctx.proposals.getState(args.id);
        // 组织隔离：其他组织 agent 的提案一律按不存在处理（不泄露其存在性）
        if (state.status === "unknown" || state.detail === null || state.detail.orgId !== org) {
          throw new DomainError("NOT_FOUND", `提案不存在：${args.id}（提案 ID 由 update_ticket_status 在 staged 模式返回）`);
        }
        switch (state.status) {
          case "pending":
            return {
              id: args.id,
              status: "pending",
              to_status: state.detail.toStatus,
              expires_at: state.detail.expiresAt,
              note: "等待人工批准（npm run proposal -- approve）；未批准不会执行写入",
            };
          case "rejected":
            return { id: args.id, status: "rejected", note: "提案已被拒绝（或批准后应用失败），变更未生效" };
          case "expired":
            return {
              id: args.id,
              status: "expired",
              note: "提案已过未决时限（视为拒绝，安全侧倾斜），变更未生效；如仍需变更请重新发起",
            };
          case "applied":
            return { id: args.id, status: "applied", to_status: state.detail.toStatus };
          case "approved":
            return {
              id: args.id,
              status: "approved",
              to_status: state.detail.toStatus,
              note: "已批准，服务端 worker 正在重新校验并应用",
            };
          default:
            throw new Error("不可达：未知提案状态");
        }
      }),
  );
}

/**
 * staged 写模式：update_ticket_status 不直接生效，而是创建提案（pending，带过期时间）。
 * 快速失败：工单不存在或迁移非法时直接报错，不产生提案——审批负担只留给合法请求。
 * 审计照常由 guard 记录（decision allow）。
 */
async function stageTicketStatusChange(
  ctx: ToolContext,
  org: number,
  args: { kind: TicketKind; id: string; to_status: string; reason: string },
): Promise<unknown> {
  const subjectId = requireNumericId(args.id, args.kind);
  const existing = await ctx.client.getTicket(org, args.kind, subjectId);
  if (!existing) {
    throw new DomainError("NOT_FOUND", `未找到 ${args.kind} 工单（${args.id}，组织 ${org}）`);
  }
  // 先过状态机再建提案：非法迁移在此报错，提案根本不会创建
  assertTransition(args.kind, existing.status, args.to_status as TicketStatus);

  const detail = await ctx.proposals.create({
    sessionId: ctx.session.sid,
    orgId: org,
    tool: "update_ticket_status",
    kind: args.kind,
    subjectHashId: args.id,
    subjectId,
    fromStatus: existing.status,
    toStatus: args.to_status,
    reason: args.reason,
  });

  return {
    proposal: {
      id: detail.id,
      status: "pending",
      from_status: detail.fromStatus,
      to_status: detail.toStatus,
      expires_at: detail.expiresAt,
    },
    note: "staged 模式：变更未生效，等待人工批准；批准后由服务端 worker 主动应用",
  };
}

function requireNumericId(hash: string, kind: TicketKind): number {
  const n = decodeId(hash, kind as HashIdScope);
  if (n === null || !Number.isFinite(n) || n <= 0) {
    throw new DomainError("BAD_ID", `无法解析工单 ID：${hash}（期望 kind=${kind} 的 hashId）`);
  }
  return n;
}
