BEGIN;

-- Trusted, explicitly provisioned sharing grants; never writable by the public API.
-- Delete a row when a member leaves. Preferences are not membership grants.
CREATE TABLE IF NOT EXISTS ai_org_memberships (
  org_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

-- Claim and accounting updates commit together, so replay does not double bill.
CREATE TABLE IF NOT EXISTS ai_usage_receipts (
  config_id BIGINT NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  session_sid TEXT NOT NULL,
  event_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, session_sid, event_key)
);

INSERT INTO agent_schema_migrations (version, description)
VALUES ('0.5', 'Explicit organization sharing grants and idempotent usage receipts')
ON CONFLICT (version) DO NOTHING;
COMMIT;
