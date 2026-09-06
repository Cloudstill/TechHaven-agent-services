/**
 * 语义层类型（对应设计文档 Context/语义层）：
 * 把物理 schema（数据库列名）翻译成 agent 可读的业务含义与指标口径，
 * 让 agent「从猜 schema 变查口径」——先查语义，再操作数据。
 */

/** 语义层覆盖的工单类型（与 domain 的 TicketKind 对齐，独立声明避免语义层反向依赖域层） */
export type SemanticKind = "requirement" | "bug" | "task";

/** 单个字段的业务语义 */
export interface SemanticField {
  column_name: string; // 物理列名（数据库 snake_case 风格）
  biz_name: string; // 业务名（如「状态」）
  biz_description?: string; // 业务含义（如「new=新建，accepted=已接受……」）
  example?: string;
  sensitive: boolean; // 敏感字段标记（P0 mock 全部 false，但字段要保留）
}

/** 一类工单对象的整体语义 */
export interface ObjectSemantics {
  subject_table: string; // "requirements" | "bugs" | "tasks"
  biz_name: string; // 「需求」「缺陷」「任务」
  description?: string;
  fields: SemanticField[];
}

/** 指标口径 */
export interface MetricSemantics {
  name: string; // 「缺陷解决时长」
  caliber: string; // 口径定义
  sql_hint?: string;
}

export interface SemanticsProvider {
  describeObject(kind: SemanticKind): Promise<ObjectSemantics | null>;
  listMetrics(): Promise<MetricSemantics[]>;
}
