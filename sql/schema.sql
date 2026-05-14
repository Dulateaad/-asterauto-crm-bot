-- asterauto-crm-bot: PostgreSQL на VPS (замена Firestore ltb*)

CREATE TABLE IF NOT EXISTS ltb_users (
  telegram_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'atz', 'rop', 'admin', 'none')),
  active BOOLEAN NOT NULL DEFAULT true,
  department_id TEXT,
  brands TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ltb_settings (
  id TEXT PRIMARY KEY,
  last_manager_idx_by_brand JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ltb_settings (id) VALUES ('app') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ltb_leads (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  fio TEXT NOT NULL,
  phone TEXT NOT NULL,
  brand TEXT NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('credit', 'cash', 'tradein')),
  budget TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('new', 'contacted', 'meeting', 'transferred', 'won', 'lost')),
  created_by BIGINT NOT NULL,
  assigned_to BIGINT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_contact_at TIMESTAMPTZ,
  meeting_at TIMESTAMPTZ,
  lost_reason TEXT,
  sla15_sent BOOLEAN NOT NULL DEFAULT false,
  sla30_sent BOOLEAN NOT NULL DEFAULT false,
  transferred_out_count INT NOT NULL DEFAULT 0,
  buyer_telegram_id BIGINT,
  buyer_survey_visit_pending BOOLEAN NOT NULL DEFAULT false,
  buyer_survey_visit_sent BOOLEAN NOT NULL DEFAULT false,
  buyer_survey_complete BOOLEAN NOT NULL DEFAULT false,
  buyer_survey JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_leads_assigned ON ltb_leads (assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_status_new ON ltb_leads (status) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_leads_created ON ltb_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_buyer_pending ON ltb_leads (buyer_survey_visit_pending)
  WHERE buyer_survey_visit_pending = true AND buyer_survey_visit_sent = false;

CREATE TABLE IF NOT EXISTS ltb_transfers (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES ltb_leads(id) ON DELETE CASCADE,
  from_telegram_id BIGINT NOT NULL,
  to_telegram_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  target TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transfers_created ON ltb_transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_lead ON ltb_transfers (lead_id);

CREATE TABLE IF NOT EXISTS ltb_buyer_contacts (
  telegram_id BIGINT PRIMARY KEY,
  fio TEXT NOT NULL,
  phone TEXT NOT NULL,
  brands TEXT[] NOT NULL DEFAULT '{}',
  marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_lead_id TEXT
);
