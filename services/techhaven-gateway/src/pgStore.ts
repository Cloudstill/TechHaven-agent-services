import os from "node:os";
import pg from "pg";
import type { EngineEvent, SessionStatus } from "./types.js";
import { log } from "./log.js";

const ACTIVE_STATUSES: readonly SessionStatus[] = ["queued", "running", "awaiting_permission"];

/** 租约时长（毫秒）：runner 必须在此周期内续约；过期视为失联 */
const DEFAULT_LEASE_MS = 30_000;
/** 心跳周期（毫秒）：定期续约 */
const DEFAULT_HEARTBEAT_MS = 10_000;
/** 单活门禁：advisory_lock 的 key；启动时拿不到则拒绝启动 */
const SINGLETON_LOCK_KEY = 141402;

export interface GatewayPgStoreOptions {
  /** 当前实例 ID；按需注入，缺省生成 hostname:pid:random */
  instanceId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  /**
   * 是否启用单活门禁。审查意见 F4：实例归属/租约/fencing token 完善前，
   * PG 部署必须强制单活 —— 这里默认开启；联调多实例前通过 false 临时关闭。
   */
  enforceSingleton?: boolean;
}

function defaultInstanceId(): string {
  const hostname = os.hostname().slice(0, 64);
  const pid = process.pid;
  const random = Math.random().toString(36).slice(2, 8);
  return `${hostname}:${pid}:${random}`;
}

export interface PersistedGatewaySession {
  ownerActor?: string;
  sid: string;
  orgId: number;
  subjectType?: string;
  subjectId?: string;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  events: EngineEvent[];
}

interface SessionRow {
  id: string;
  sid: string;
  org_id: number;
  status: SessionStatus;
  created_at: Date | string;
  ended_at: Date | string | null;
  exit_info: { subject_type?: unknown; subject_id?: unknown; owner_actor?: unknown } | null;
}

interface EventRow {
  sid: string;
  seq: string;
  ts: Date | string;
  type: EngineEvent["type"];
  payload: Record<string, unknown>;
}

export class PgQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgQuotaError";
  }
}

/** PostgreSQL 权威的 Gateway session/event adapter；JSONL 仅由 registry 继续作为 spool。
 *
 * 实例归属（审查意见 F4）：每个会话记录 runner_id 与 lease_expires_at；
 * restore 只接管「本实例的活动会话」与「租约已过期的失联会话」，
 * 避免把仍在运行的其他实例的活动会话误标为 failed。
 * 启动时默认强制单活（pg_try_advisory_lock），防止多实例互相抢占同一 PG 的活动会话。 */
export class GatewayPgStore {
  private singletonClient: pg.PoolClient | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
    options: GatewayPgStoreOptions = {},
  ) {
    this.instanceId = options.instanceId?.trim() || defaultInstanceId();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  static forTesting(pool: pg.Pool, schema = "public", options: GatewayPgStoreOptions = {}): GatewayPgStore {
    return new GatewayPgStore(pool, schema, { ...options, enforceSingleton: false });
  }

  static async connect(
    dbUrl: string,
    schema = "public",
    options: GatewayPgStoreOptions = {},
  ): Promise<GatewayPgStore> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error(`PostgreSQL schema 非法：${schema}`);
    const pool = new pg.Pool({
      connectionString: dbUrl,
      max: 8,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("SELECT 1");
      const store = new GatewayPgStore(pool, schema, options);
      if (options.enforceSingleton !== false) await store.acquireSingleton();
      store.startHeartbeat();
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /** 单活门禁：会话级 advisory_lock；进程崩溃/连接断开时锁自动释放 */
  private async acquireSingleton(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1, 0) AS ok",
        [SINGLETON_LOCK_KEY],
      );
      if (!result.rows[0]?.ok) {
        client.release();
        throw new Error(
          `PG 部署当前强制单活：另一 Gateway 实例持有 advisory_lock(${SINGLETON_LOCK_KEY}, 0)。` +
            `实例归属/租约/fencing 机制完善之前不允许多实例，关闭其他实例后再启动。`,
        );
      }
      this.singletonClient = client;
    } catch (err) {
      void client.release();
      throw err;
    }
  }

  /** 续约：本实例正在跑的活动会话必须定期延长 lease，否则会被新实例接管 */
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE agent_sessions
            SET lease_expires_at = now() + ($2::text || ' milliseconds')::interval
          WHERE runner_id = $1
            AND status = ANY($3::agent_session_status[])`,
        [this.instanceId, String(this.leaseMs), ACTIVE_STATUSES],
      );
    } catch (err) {
      log(`心跳续约失败（${this.instanceId}）：`, err);
    }
  }

  /** 当前实例 ID（调试/审计用） */
  get currentInstanceId(): string {
    return this.instanceId;
  }

  async restore(retentionMinutes: number): Promise<PersistedGatewaySession[]> {
    // 只恢复：
    //   1. 本实例的活动会话（runner_id = instanceId 且仍在续约）
    //   2. 租约已过期的活动会话（视为失联，可被本实例接管）
    //   3. 保留期内已结束的会话
    // 仍由其他实例持有的活动会话不恢复 —— 避免把它们误标为 failed（审查意见 F4）。
    const instanceParam = this.instanceId;
    const retention =
      retentionMinutes > 0
        ? `WHERE (s.ended_at IS NULL OR s.ended_at > now() - ($2::text || ' minutes')::interval)
            AND (
              s.ended_at IS NOT NULL
              OR s.runner_id = $1
              OR s.runner_id IS NULL
              OR s.lease_expires_at IS NULL
              OR s.lease_expires_at <= now()
            )`
        : `WHERE s.runner_id = $1
             OR s.runner_id IS NULL
             OR s.lease_expires_at IS NULL
             OR s.lease_expires_at <= now()`;
    const params: unknown[] = retentionMinutes > 0 ? [instanceParam, retentionMinutes] : [instanceParam];
    const sessions = await this.pool.query<SessionRow>(
      `SELECT s.id, s.sid, s.org_id, s.status, s.created_at, s.ended_at, s.exit_info
         FROM agent_sessions s
         ${retention}
        ORDER BY s.created_at, s.id`,
      params,
    );
    if (sessions.rows.length === 0) return [];
    const ids = sessions.rows.map((row) => row.id);
    const events = await this.pool.query<EventRow>(
      `SELECT s.sid, e.seq, e.ts, e.type, e.payload
         FROM agent_events e
         JOIN agent_sessions s ON s.id = e.session_id
        WHERE e.session_id = ANY($1::bigint[])
        ORDER BY e.session_id, e.seq`,
      [ids],
    );
    const bySid = new Map<string, EngineEvent[]>();
    for (const row of events.rows) {
      const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
      const event = {
        ...payload,
        type: row.type,
        seq: Number(row.seq),
        ts: new Date(row.ts).toISOString(),
      } as EngineEvent;
      const list = bySid.get(row.sid) ?? [];
      list.push(event);
      bySid.set(row.sid, list);
    }
    return sessions.rows.map((row) => ({
      sid: row.sid,
      ...(typeof row.exit_info?.owner_actor === "string" ? { ownerActor: row.exit_info.owner_actor } : {}),
      orgId: Number(row.org_id),
      ...(typeof row.exit_info?.subject_type === "string" ? { subjectType: row.exit_info.subject_type } : {}),
      ...(typeof row.exit_info?.subject_id === "string" ? { subjectId: row.exit_info.subject_id } : {}),
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.ended_at ? { endedAt: new Date(row.ended_at).toISOString() } : {}),
      events: bySid.get(row.sid) ?? [],
    }));
  }

  /** advisory transaction lock + authoritative count prevents multi-instance quota oversubscription. */
  async createSession(
    input: {
      ownerActor?: string;
      sid: string;
      orgId: number;
      subjectType?: string;
      subjectId?: string;
      createdAt: string;
    },
    maxSessionsPerOrg: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(141402, $1)", [input.orgId]);
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM agent_sessions
          WHERE org_id = $1 AND status = ANY($2::agent_session_status[])`,
        [input.orgId, ACTIVE_STATUSES],
      );
      const active = Number(count.rows[0]?.count ?? 0);
      if (active >= maxSessionsPerOrg) {
        throw new PgQuotaError(`组织 ${input.orgId} 活动会话数已达配额（${active}/${maxSessionsPerOrg}）`);
      }
      const identity = await client.query<{ id: string }>(
        `INSERT INTO agent_identities (org_id, name, kind, created_by)
         VALUES ($1, 'techhaven-gateway', 'pipeline', 0)
         ON CONFLICT (org_id, name) DO UPDATE SET status = 'active'
         RETURNING id`,
        [input.orgId],
      );
      const identityId = identity.rows[0]?.id;
      if (!identityId) throw new Error("Gateway PG identity upsert 未返回 id");
      await client.query(
        `INSERT INTO agent_sessions
           (sid, identity_id, org_id, engine, engine_version, profile, status, created_at, exit_info, runner_id, lease_expires_at)
         VALUES ($1, $2, $3, 'techhaven-gateway', '0.1.0', 'managed', 'queued', $4,
                 jsonb_strip_nulls(jsonb_build_object('subject_type', $5::text, 'subject_id', $6::text, 'owner_actor', $7::text)),
                 $8,
                 now() + ($9::text || ' milliseconds')::interval)`,
        [
          input.sid,
          identityId,
          input.orgId,
          input.createdAt,
          input.subjectType ?? null,
          input.subjectId ?? null,
          input.ownerActor ?? null,
          this.instanceId,
          String(this.leaseMs),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 事件先提交 PG，再由 registry 更新内存/SSE；false 表示 sid+seq 已存在。 */
  async appendEvent(sid: string, event: EngineEvent): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{ id: string; status: SessionStatus }>(
        `SELECT id, status FROM agent_sessions WHERE sid = $1 FOR UPDATE`,
        [sid],
      );
      const row = session.rows[0];
      if (!row) throw new Error(`Gateway PG 中不存在会话：${sid}`);
      const { seq, ts, type, ...payload } = event;
      const inserted = await client.query(
        `INSERT INTO agent_events (session_id, seq, ts, type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [row.id, seq, ts, type, JSON.stringify(payload)],
      );
      if (inserted.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      if (event.type === "status_change") {
        const terminal = event.status === "succeeded" || event.status === "failed" || event.status === "cancelled";
        await client.query(
          `UPDATE agent_sessions
              SET status = $1,
                  started_at = CASE WHEN $1 = 'running' THEN COALESCE(started_at, $2::timestamptz) ELSE started_at END,
                  ended_at = CASE WHEN $3::boolean THEN $2::timestamptz ELSE ended_at END,
                  exit_info = CASE WHEN $3::boolean
                    THEN COALESCE(exit_info, '{}'::jsonb) || jsonb_build_object('detail', $4::text)
                    ELSE exit_info END
            WHERE id = $5`,
          [event.status, event.ts, terminal, event.detail ?? null, row.id],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // 释放单活 advisory_lock（释放连接即可，会话级锁随连接断开自动释放）
    if (this.singletonClient) {
      void this.singletonClient.release();
      this.singletonClient = undefined;
    }
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
