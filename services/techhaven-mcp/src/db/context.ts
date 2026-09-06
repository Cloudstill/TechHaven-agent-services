import pg from "pg";
import { log } from "../log.js";

/**
 * DB 会话上下文：一次引擎会话内所有 DB 落地路径（审计双写 / 写提案落库 / 语义层 DB Provider）
 * 共用的连接池与身份锚点。
 *
 * 抽出自原 DbAuditSink（P0 只有审计用 DB）；P2 起三条路径共用一个 pool，
 * 避免同一会话开多条连接、重复做 identity/session bootstrap。
 * 本模块静态导入 pg，因此只允许被惰性加载（index.ts 里 TECHHAVEN_DB_URL 分支动态 import），
 * 无 DB 场景（mock 后端 / CLI）不付出 pg 的加载成本。
 */
export class PgContext {
  private constructor(
    readonly pool: pg.Pool,
    /** agent_identities.id（BIGINT；node-pg 默认把 BIGINT 解析为 string 防精度丢失，原样回传即可） */
    readonly identityId: string,
    /** agent_sessions.id（同上，insert agent_* 表时的 session_id 外键值） */
    readonly sessionId: string,
  ) {}

  /**
   * 建立 pool 并 bootstrap 身份/会话（逻辑与原 DbAuditSink.init 一致，行为不变）。
   * 失败时抛出（连接池已在内部释放），由调用方决定降级路径（仅 JSONL 审计 + mock 语义层）。
   */
  static async create(
    dbUrl: string,
    agentName: string,
    orgId: number,
    sid: string,
    engineVersion: string,
  ): Promise<PgContext> {
    const pool = new pg.Pool({
      connectionString: dbUrl,
      max: 1, // 单连接足够：审计/提案/语义均为低频读写，并发查询在池内排队
      connectionTimeoutMillis: 5000, // 网络黑洞时快速失败，避免启动期挂死
    });
    try {
      // created_by=0：P0 阶段 MCP 进程无登录上下文，用 0 作为哨兵值占位
      // （真实签发人要等 P1 由 Gateway 下发后回填）
      const identity = await pool.query<{ id: string }>(
        `INSERT INTO agent_identities (org_id, name, kind, created_by)
         VALUES ($1, $2, 'assistant', 0)
         ON CONFLICT (org_id, name) DO UPDATE SET status = 'active'
         RETURNING id`,
        [orgId, agentName],
      );
      if (identity.rows.length === 0) {
        throw new Error("agent_identities upsert 未返回 id");
      }
      const identityId = identity.rows[0].id;

      const session = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions
           (sid, identity_id, org_id, engine, engine_version, profile, status, started_at)
         VALUES ($1, $2, $3, 'dsh', $4, 'p0', 'running', now())
         ON CONFLICT (sid) DO UPDATE SET status = 'running', started_at = now()
         RETURNING id`,
        [sid, identityId, orgId, engineVersion],
      );
      if (session.rows.length === 0) {
        throw new Error("agent_sessions upsert 未返回 id");
      }
      return new PgContext(pool, identityId, session.rows[0].id);
    } catch (err) {
      log("DB 会话上下文初始化失败:", err);
      await PgContext.quietEnd(pool);
      throw err;
    }
  }

  /** 释放连接池（失败降级路径 / 显式关闭用；正常生命周期随进程退出） */
  async close(): Promise<void> {
    await PgContext.quietEnd(this.pool);
  }

  /** pool.end() 的吞错版本：关闭失败不影响主流程 */
  private static async quietEnd(pool: pg.Pool): Promise<void> {
    try {
      await pool.end();
    } catch {
      // 关闭失败不影响主流程
    }
  }
}
