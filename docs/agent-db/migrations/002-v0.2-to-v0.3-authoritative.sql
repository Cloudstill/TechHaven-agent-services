-- TechHaven Agent DB v0.2 -> v0.3
-- 可重复执行；先为旧镜像行补稳定引用，再把 proposal_ref 提升为权威并发键。

BEGIN;

CREATE TABLE IF NOT EXISTS agent_schema_migrations (
  version      TEXT PRIMARY KEY,
  description TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_write_proposals
  ADD COLUMN IF NOT EXISTS proposal_ref TEXT;

ALTER TABLE agent_write_proposals
  ADD COLUMN IF NOT EXISTS request_key TEXT;

UPDATE agent_write_proposals
   SET proposal_ref = 'legacy_' || id::text
 WHERE proposal_ref IS NULL OR btrim(proposal_ref) = '';

UPDATE agent_write_proposals
   SET request_key = 'legacy_' || id::text
 WHERE request_key IS NULL OR btrim(request_key) = '';

ALTER TABLE agent_write_proposals
  ALTER COLUMN proposal_ref SET NOT NULL,
  ALTER COLUMN request_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_write_proposals_ref
  ON agent_write_proposals (proposal_ref);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_write_proposals_request
  ON agent_write_proposals (session_id, request_key);

INSERT INTO agent_schema_migrations (version, description)
VALUES ('0.3', 'PostgreSQL authoritative proposal/session/event baseline')
ON CONFLICT (version) DO NOTHING;

COMMIT;
