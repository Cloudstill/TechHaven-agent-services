import type { PgContext } from "../db/context.js";
import type {
  MetricSemantics,
  ObjectSemantics,
  SemanticField,
  SemanticKind,
  SemanticsProvider,
} from "./types.js";

/** kind → semantic_objects.subject_table 映射（列名逐字对照 schema.sql §7） */
const KIND_TO_TABLE: Record<SemanticKind, string> = {
  requirement: "requirements",
  bug: "bugs",
  task: "tasks",
};

/** describeObject 的行形状：semantic_objects LEFT JOIN semantic_fields（对象在、字段暂缺也能组装） */
interface ObjectRow {
  subject_table: string;
  biz_name: string;
  description: string | null;
  column_name: string | null;
  field_biz_name: string | null;
  biz_description: string | null;
  example: string | null;
  sensitive: boolean;
}

/** listMetrics 的行形状 */
interface MetricRow {
  name: string;
  caliber: string;
  sql_hint: string | null;
}

/** 缓存 TTL（毫秒）：语义数据靠人工低频维护，60s 内读到旧口径可接受，又能把每次工具调用的 DB 往返压到接近零 */
const CACHE_TTL_MS = 60_000;
/** 缓存条目上限：key 固定为 object:{kind} ×3 + metrics，正常到不了；超限整体清空防意外增长 */
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * 语义层 DB Provider（P2）：semantic_* 表替代 P0 mock（docs/agent-db/schema.sql §7）。
 *
 * - 数据仍需人工策展（INSERT semantic_objects / semantic_fields / semantic_metrics）；
 *   查无该对象时返回 null（get_semantics 呈现 notFound），不会回退到 mock。
 * - 查询失败向上抛：语义读失败被伪装成 notFound 会误导 agent「这个对象没有语义」，
 *   宁可让本次 get_semantics 报错（guard 会审计原因后再交给 MCP 层）。
 */
export class DbSemanticsProvider implements SemanticsProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly opts: { ctx: PgContext; orgId: number },
  ) {}

  async describeObject(kind: SemanticKind): Promise<ObjectSemantics | null> {
    const cached = this.getCached<ObjectSemantics | null>(`object:${kind}`);
    if (cached !== undefined) return cached;

    // 列名 biz_name/biz_description/example/sensitive 逐字对照 semantic_fields 定义
    const { rows } = await this.opts.ctx.pool.query<ObjectRow>(
      `SELECT o.subject_table,
              o.biz_name,
              o.description,
              f.column_name,
              f.biz_name   AS field_biz_name,
              f.biz_description,
              f.example,
              f.sensitive
         FROM semantic_objects o
         LEFT JOIN semantic_fields f ON f.object_id = o.id
        WHERE o.subject_table = $1
        ORDER BY f.id`,
      [KIND_TO_TABLE[kind]],
    );
    // 查无该对象 → null；LEFT JOIN 命中对象但暂无字段时组装出空 fields（不误报 notFound）
    const object = rows.length === 0 ? null : this.assembleObject(rows);
    this.setCached(`object:${kind}`, object);
    return object;
  }

  async listMetrics(): Promise<MetricSemantics[]> {
    const cached = this.getCached<MetricSemantics[]>("metrics");
    if (cached !== undefined) return cached;

    // 指标按组织隔离（semantic_metrics.org_id）；sql_hint 可空，空则省略该键（对齐 mock 的可选形状）
    const { rows } = await this.opts.ctx.pool.query<MetricRow>(
      `SELECT name, caliber, sql_hint
         FROM semantic_metrics
        WHERE org_id = $1
        ORDER BY id`,
      [this.opts.orgId],
    );
    const metrics: MetricSemantics[] = rows.map((r) => ({
      name: r.name,
      caliber: r.caliber,
      ...(r.sql_hint !== null ? { sql_hint: r.sql_hint } : {}),
    }));
    this.setCached("metrics", metrics);
    return metrics;
  }

  /** 组装 ObjectSemantics：首行携带对象级信息，其余行折叠成字段列表 */
  private assembleObject(rows: ObjectRow[]): ObjectSemantics {
    const first = rows[0];
    const fields: SemanticField[] = [];
    for (const row of rows) {
      if (row.column_name === null) continue; // LEFT JOIN 未命中字段行（该对象暂无策展字段）
      fields.push({
        column_name: row.column_name,
        biz_name: row.field_biz_name ?? row.column_name,
        biz_description: row.biz_description ?? undefined,
        example: row.example ?? undefined,
        sensitive: row.sensitive,
      });
    }
    return {
      subject_table: first.subject_table,
      biz_name: first.biz_name,
      description: first.description ?? undefined,
      fields,
    };
  }

  /**
   * 简单内存缓存（Map + 时间戳）。PoC 取舍：
   *   1. 不做失效通知/版本号——语义数据靠人工 UPDATE，60s 内读到旧口径可接受，DB 永远是真值；
   *   2. 不上 LRU——key 集合固定且极小（3 类对象 + 1 组指标），超限整体清空即可；
   *   3. 进程级缓存，跨进程一致性不在 P2 范围。
   */
  private getCached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    this.cache.delete(key);
    return undefined;
  }

  private setCached(key: string, value: unknown): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
  }
}
