-- ============================================================================
-- Migration: v0.5 → v0.7
-- 审查意见 F4：PG 模式启动恢复要按执行实例归属，不能把仍在跑的其他实例的
-- 活动会话误判为「重启丢失句柄」。
--
-- 增加两列 + 一个「待接管」索引；启动时 Gateway 用 pg_try_advisory_lock
-- 强制单活（单活门禁写在 pgStore.ts，不在本迁移里实现）：
--   runner_id          TEXT        -- 当前持有者；缺省为 NULL（历史遗留会话）
--   lease_expires_at   TIMESTAMPTZ -- runner 失联判定边界；缺省为 NULL
--
-- restore 的规则（pgStore.ts 中）：
--   1. 本实例的活动会话（runner_id = instanceId 且未到期）
--   2. 租约已过期的活动会话（视为失联，可被本实例接管）
--   3. 保留期内的已结束会话
--   —— 其余（被其他实例持有的活动会话）不会被本实例恢复/接管。
-- ============================================================================

BEGIN;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS runner_id        TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- 待接管 / 当前实例的活动会话：联调多实例时便于查询归属与续约状况。
CREATE INDEX IF NOT EXISTS idx_sessions_runner_lease
  ON agent_sessions (runner_id, lease_expires_at)
  WHERE ended_at IS NULL;

-- 待接管：runner 失联但活动会话仍挂着的告警与运维查询入口。
CREATE INDEX IF NOT EXISTS idx_sessions_lease_expired
  ON agent_sessions (lease_expires_at)
  WHERE ended_at IS NULL AND lease_expires_at IS NOT NULL;

INSERT INTO agent_schema_migrations (version, description)
VALUES ('0.7', 'Gateway session ownership + lease + singleton gate (multi-instance false positives)')
ON CONFLICT (version) DO NOTHING;

COMMIT;