-- TechHaven Agent DB v0.3 -> v0.4
-- AI 配置资产化：一个账号多套配置、组织共享 + 个人优先、用量统计与配额。
--
-- 设计要点：
--   1. 密钥只以密文落地（api_key_cipher），明文仅在解析时短暂存在于内存；
--   2. 指纹 api_key_fp 用于「是否同一把钥匙」的判断与审计关联，不可逆；
--   3. 脱敏串 api_key_masked 单独存，列表页无需解密即可展示；
--   4. 个人优先于组织：解析链见 services/techhaven-gateway/src/aiConfigAssets.ts；
--   5. 金额一律用「微元」(cost_micros) 存储，避免浮点累计误差。
--
-- 可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS agent_schema_migrations (
  version     TEXT PRIMARY KEY,
  description TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE ai_config_scope AS ENUM ('user', 'org');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 1. 配置资产本体：scope 区分归属，一账号可持有多套（name 唯一）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_configs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope            ai_config_scope NOT NULL,
  owner_id         BIGINT      NOT NULL,              -- scope=user → users.id；scope=org → organizations.id
  name             TEXT        NOT NULL,              -- 用户可见的资产名，如「工作 GPT」「测试 GLM」
  provider_type    TEXT        NOT NULL,              -- openai | claude | glm（决定 dsh 环境变量与 provider route）
  service_provider TEXT        NOT NULL DEFAULT 'custom', -- openai | anthropic | zhipu | custom
  response_type    TEXT        NOT NULL DEFAULT 'chat_completions', -- responses | chat_completions | messages
  endpoint_url     TEXT        NOT NULL,
  api_key_cipher   BYTEA       NOT NULL,              -- AES-256-GCM 密文（含 iv 与 tag）
  api_key_fp       TEXT        NOT NULL,              -- sha256(明文) 前 16 位；去重/审计，不可逆
  api_key_masked   TEXT        NOT NULL,              -- 脱敏显示，如 sk-***3f9a
  key_version      INTEGER     NOT NULL DEFAULT 1,    -- 主密钥版本，支持轮换后逐条重加密
  model            TEXT,
  reasoning_effort TEXT,
  max_tokens       INTEGER,
  is_default       BOOLEAN     NOT NULL DEFAULT false,
  shared           BOOLEAN     NOT NULL DEFAULT false, -- 仅 scope=org 有意义：是否对组织成员开放
  status           TEXT        NOT NULL DEFAULT 'active', -- active | disabled | quota_exceeded
  created_by       BIGINT      NOT NULL,              -- → users.id
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  CONSTRAINT ck_ai_configs_provider CHECK (provider_type IN ('openai', 'claude', 'glm')),
  CONSTRAINT ck_ai_configs_service  CHECK (service_provider IN ('openai', 'anthropic', 'zhipu', 'custom')),
  CONSTRAINT ck_ai_configs_response CHECK (response_type IN ('responses', 'chat_completions', 'messages')),
  CONSTRAINT ck_ai_configs_status   CHECK (status IN ('active', 'disabled', 'quota_exceeded')),
  -- 与前端/网关校验对齐：Agent 运行要求 HTTPS，仅本机回环允许明文 HTTP
  CONSTRAINT ck_ai_configs_endpoint CHECK (
    endpoint_url LIKE 'https://%'
    OR endpoint_url LIKE 'http://127.%'
    OR endpoint_url LIKE 'http://localhost%'
    OR endpoint_url LIKE 'http://[::1]%'
  ),
  CONSTRAINT ck_ai_configs_tokens   CHECK (max_tokens IS NULL OR max_tokens > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_configs_owner_name
  ON ai_configs (scope, owner_id, name);
-- 每个归属下最多一个默认配置（NULL 不参与唯一，用部分索引精确约束 true）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_configs_default
  ON ai_configs (scope, owner_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_ai_configs_owner
  ON ai_configs (scope, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_configs_fp
  ON ai_configs (api_key_fp);

-- ---------------------------------------------------------------------------
-- 2. 用量：按「配置 × 天」聚合，供配额判定与账单展示
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_id         BIGINT      NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  usage_date        DATE        NOT NULL,
  session_count     INTEGER     NOT NULL DEFAULT 0,
  request_count     INTEGER     NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT      NOT NULL DEFAULT 0,
  completion_tokens BIGINT      NOT NULL DEFAULT 0,
  total_tokens      BIGINT      NOT NULL DEFAULT 0,
  cost_micros       BIGINT      NOT NULL DEFAULT 0,   -- 百万分之一元；整数累加无浮点误差
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_usage_non_negative CHECK (
    session_count >= 0 AND request_count >= 0
    AND prompt_tokens >= 0 AND completion_tokens >= 0
    AND total_tokens >= 0 AND cost_micros >= 0
  ),
  UNIQUE (config_id, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON ai_usage_daily (usage_date);

-- ---------------------------------------------------------------------------
-- 3. 配额：挂在单套配置上，超限时把配置置为 quota_exceeded 并拒绝解析
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_quotas (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_id   BIGINT      NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  period      TEXT        NOT NULL,                    -- daily | monthly
  metric      TEXT        NOT NULL,                    -- tokens | requests | cost_micros
  limit_value BIGINT      NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_ai_quotas_period   CHECK (period IN ('daily', 'monthly')),
  CONSTRAINT ck_ai_quotas_metric   CHECK (metric IN ('tokens', 'requests', 'cost_micros')),
  CONSTRAINT ck_ai_quotas_positive CHECK (limit_value > 0),
  UNIQUE (config_id, period, metric)
);

-- ---------------------------------------------------------------------------
-- 4. 使用明细：谁、在哪个会话、用了哪把钥匙（审计与归属追责）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_config_usages (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_id      BIGINT      NOT NULL REFERENCES ai_configs(id),
  scope_snapshot TEXT        NOT NULL,                 -- user | org：命中哪一层配置
  resolved_from  TEXT        NOT NULL,                 -- explicit | user_default | user_named | org_default
  user_id        BIGINT      NOT NULL,                 -- 实际使用者 → users.id
  session_sid    TEXT,                                 -- → agent_sessions.sid
  request_count  INTEGER     NOT NULL DEFAULT 0,
  total_tokens   BIGINT      NOT NULL DEFAULT 0,
  cost_micros    BIGINT      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_config_usages_scope   CHECK (scope_snapshot IN ('user', 'org')),
  CONSTRAINT ck_config_usages_resolve CHECK (
    resolved_from IN ('explicit', 'user_default', 'user_named', 'org_default')
  )
);
CREATE INDEX IF NOT EXISTS idx_config_usages_config_time ON ai_config_usages (config_id, created_at);
CREATE INDEX IF NOT EXISTS idx_config_usages_user        ON ai_config_usages (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. 用户偏好：记住「当前选哪一把」，为空则走默认解析链
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_ai_preferences (
  user_id          BIGINT PRIMARY KEY,                 -- → users.id
  org_id           BIGINT,                             -- 当前组织上下文；解析组织配置时用
  active_config_id BIGINT REFERENCES ai_configs(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. 便捷视图：配置 + 累计用量（人看的地方）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ai_config_usage AS
SELECT
  c.id                              AS config_id,
  c.scope,
  c.owner_id,
  c.name,
  c.status,
  c.api_key_masked,
  c.last_used_at,
  COALESCE(SUM(u.request_count), 0) AS total_requests,
  COALESCE(SUM(u.total_tokens), 0)  AS total_tokens,
  COALESCE(SUM(u.cost_micros), 0)   AS total_cost_micros
FROM ai_configs c
LEFT JOIN ai_usage_daily u ON u.config_id = c.id
GROUP BY c.id;

INSERT INTO agent_schema_migrations (version, description)
VALUES ('0.4', 'AI config assets: multi-config per account, org sharing, usage and quota')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- 数据保留策略（建议，由后端定时任务执行）
-- ---------------------------------------------------------------------------
-- ai_usage_daily    : 保留 400 天（账单核对周期）
-- ai_config_usages  : 保留 365 天（审计合规要求；配置删除后明细仍须留存）
-- ai_configs        : 删除配置时级联清理用量与配额，但保留使用明细用于追责
