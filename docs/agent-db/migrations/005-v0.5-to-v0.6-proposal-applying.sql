-- ============================================================================
-- Migration: v0.5 → v0.6
-- 审查意见 F2：为写提案的应用阶段引入独占领取态 applying + 应用租约。
--
-- 背景：applyApproved 原来「读到 approved → 执行业务写回调 → 追加 applied」，
-- 而控制面允许 approved → rejected。两者不共享事务，业务写期间撤回会成功，
-- 结果出现「审批结果 rejected、业务副作用已发生」的矛盾。
--
-- 本迁移让「正在写」成为可持久化、可检测的事实：
--   status = 'applying'  +  apply_lease_expires_at 租约，
-- worker 失联后租约到期的提案可被重新领取，不会永久悬挂。
-- ============================================================================

-- 枚举新增值：不能在事务块内执行，必须单独一条语句提交（PostgreSQL 限制）。
-- 已存在时忽略：ADD VALUE 不支持 IF NOT EXISTS，用 DO 块做幂等判断。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'applying'
                 AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'proposal_status')) THEN
    ALTER TYPE proposal_status ADD VALUE 'applying' AFTER 'approved';
  END IF;
END
$$;

BEGIN;

-- 应用租约：worker 领取（status → applying）时写入 now() + 应用租约时长；
-- 回填终态（applied / rejected）时清空。租约到期的 applying 可被其他 worker 重新领取。
ALTER TABLE agent_write_proposals
  ADD COLUMN IF NOT EXISTS apply_lease_expires_at TIMESTAMPTZ;

-- 待回收的应用中提案：供运维/守护进程扫描失联 worker。
CREATE INDEX IF NOT EXISTS idx_proposals_applying_lease
  ON agent_write_proposals (apply_lease_expires_at)
  WHERE status = 'applying';

INSERT INTO agent_schema_migrations (version, description)
VALUES ('0.6', 'Proposal applying claim state and lease (approval revoke vs. business write race)')
ON CONFLICT (version) DO NOTHING;

COMMIT;
