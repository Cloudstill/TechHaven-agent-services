import type {
  MetricSemantics,
  ObjectSemantics,
  SemanticField,
  SemanticKind,
  SemanticsProvider,
} from "./types.js";

/**
 * 人工策展的语义层数据（P0 mock）。
 *
 * - column_name 使用 TechHaven 后端数据库列名风格（snake_case），与 mockClient 中
 *   TicketRecord 的 camelCase 字段一一对应：create_time ↔ createdAt、update_time ↔ updatedAt。
 * - P0 无敏感字段，sensitive 统一 false；mask_policy（脱敏策略）的语义见 docs，
 *   语义层只负责标记 sensitive，脱敏执行在数据访问层。
 * - 真实环境应替换为从 TechHaven 语义层接口拉取的远程 Provider，接口不变。
 */

/** 字段定义样板：sensitive 恒为 false（P0 无敏感字段，mask_policy 语义见 docs） */
function field(
  columnName: string,
  bizName: string,
  bizDescription: string,
  example?: string,
): SemanticField {
  return { column_name: columnName, biz_name: bizName, biz_description: bizDescription, example, sensitive: false };
}

const OBJECTS: Record<SemanticKind, ObjectSemantics> = {
  requirement: {
    subject_table: "requirements",
    biz_name: "需求",
    description: "研发需求工单：记录产品/平台要实现的功能或改进，沿 新建→开发→测试→完成→关闭 闭环流转。",
    fields: [
      field("id", "需求ID", "需求记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。"),
      field("title", "需求标题", "一句话概括要做什么；关键词搜索主要匹配本字段。", "文章编辑器支持 Mermaid 图表导出为 PNG"),
      field("description", "需求描述", "详细说明：背景、验收标准、约束条件。判断需求范围与改不改得动，以本字段为准。"),
      field("status", "需求状态", "new=新建（已登记待排期）| developing=开发中 | testing=测试中 | done=已完成（开发验收通过）| closed=已关闭（终止态）。只能按合法迁移推进，非法迁移会被状态机拒绝。", "developing"),
      field("priority", "优先级", "high=高 | medium=中 | low=低。表达交付顺序期望，不影响状态流转。", "high"),
      field("assignee", "负责人", "当前承接人的用户名；空串表示未指派。对未指派工单先确认归属，再做推进类操作。", "chen"),
      field("creator", "创建人", "提出该需求的用户名。", "chen"),
      field("create_time", "创建时间", "需求登记时间，ISO 8601 UTC（对应接口字段 createdAt）。趋势口径的「窗口内新建」按本字段判定。", "2026-08-26T02:00:00.000Z"),
      field("update_time", "更新时间", "最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。", "2026-08-27T09:30:00.000Z"),
    ],
  },

  bug: {
    subject_table: "bugs",
    biz_name: "缺陷",
    description: "研发缺陷工单：记录平台功能异常，沿 新建→接受→处理→验证（可能复活）→关闭 闭环流转。",
    fields: [
      field("id", "缺陷ID", "缺陷记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。"),
      field("title", "缺陷标题", "一句话概括缺陷现象。", "KaTeX 公式在暗色主题下对比度不足"),
      field("description", "缺陷描述", "现象、复现步骤、期望结果与实际结果；动手修复前必读。"),
      field("status", "缺陷状态", "new=新建（待确认）| accepted=已接受（确认有效，进入处理队列）| processing=处理中（修复进行时）| verified=已验证（修复经回归确认）| reopened=已复活（验证未通过退回，需重新处理）| closed=已关闭（终止态）。new 不能直接跳到 verified，必须先 accepted。", "processing"),
      field("priority", "优先级", "urgent=紧急 | high=高 | medium=中 | low=低。缺陷比需求/任务多一档 urgent，表示阻塞发布或核心功能不可用，应最优先处理。", "urgent"),
      field("assignee", "负责人", "当前修复责任人的用户名；空串表示未指派（待认领）。", "dev01"),
      field("creator", "报告人", "报告该缺陷的用户名。", "dev02"),
      field("create_time", "创建时间", "缺陷报告时间，ISO 8601 UTC（对应接口字段 createdAt）。", "2026-08-28T03:00:00.000Z"),
      field("update_time", "更新时间", "最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。「缺陷解决时长」「缺陷复活率」等指标的窗口判定依赖状态迁移轨迹。", "2026-08-28T12:00:00.000Z"),
    ],
  },

  task: {
    subject_table: "tasks",
    biz_name: "任务",
    description: "研发任务工单：拆解到人的具体工作项，通常挂靠在需求之下，沿 待办→进行中→完成→关闭 流转。",
    fields: [
      field("id", "任务ID", "任务记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。"),
      field("title", "任务标题", "一句话概括要做的具体工作。", "升级 Vite 至 8.1 并验证构建产物"),
      field("description", "任务描述", "要做的具体工作与完成标准（DoD）；完成前逐条对照。"),
      field("status", "任务状态", "todo=待办 | doing=进行中 | done=已完成 | closed=已关闭（终止态，含作废）。", "doing"),
      field("priority", "优先级", "high=高 | medium=中 | low=低。", "medium"),
      field("assignee", "负责人", "当前执行人的用户名；空串表示未指派。", "chen"),
      field("creator", "创建人", "创建该任务的用户名。", "dev01"),
      field("create_time", "创建时间", "任务创建时间，ISO 8601 UTC（对应接口字段 createdAt）。", "2026-08-23T08:00:00.000Z"),
      field("update_time", "更新时间", "最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。", "2026-08-27T10:00:00.000Z"),
    ],
  },
};

const METRICS: MetricSemantics[] = [
  {
    name: "缺陷解决时长",
    caliber:
      "verified − accepted，按工作小时计：从缺陷被接受（accepted）到验证通过（verified）的时间差，" +
      "只累计工作日的工作时段（默认 9:00–18:00，剔除周末与节假日）。值越小说明修复链路越快；" +
      "处于 new / reopened 的缺陷不计入。",
    sql_hint: "SELECT AVG(work_hours(accepted_at, verified_at)) FROM bugs WHERE status IN ('verified', 'closed')",
  },
  {
    name: "缺陷复活率",
    caliber:
      "统计窗口内 reopened 数 / closed 数：衡量修复质量——验证通过后又被退回重开的比例。" +
      "比率越高说明验证或修复质量越差；窗口内 closed 为 0 时不输出该指标（而不是记 0）。",
    sql_hint:
      "SELECT COUNT(*) FILTER (WHERE status = 'reopened') / NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0) FROM bugs WHERE update_time >= :since",
  },
  {
    name: "需求吞吐",
    caliber:
      "统计窗口内进入 done 的需求数：按「状态迁移到 done」这一事件计（后续再 closed 不重复计），" +
      "而非按存量 done 计。衡量单位时间的需求交付量，可与趋势摘要的 newlyClosed 对照使用。",
    sql_hint: "SELECT COUNT(*) FROM requirement_status_history WHERE to_status = 'done' AND changed_at >= :since",
  },
];

/** P0 mock 语义提供者：人工策展数据，离线可用。 */
export class MockSemanticsProvider implements SemanticsProvider {
  async describeObject(kind: SemanticKind): Promise<ObjectSemantics | null> {
    return OBJECTS[kind];
  }

  async listMetrics(): Promise<MetricSemantics[]> {
    return METRICS;
  }
}
