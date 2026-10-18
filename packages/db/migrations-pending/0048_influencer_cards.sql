-- 0048 Influencer card templates (2026-10-16). PROPOSAL FOR REVIEW — NOT APPLIED TO mip OR PRODUCTION.
-- Lives outside packages/db/migrations on purpose: db:push must never pick it up.
-- Numbering: the main checkout has 0045/0046 in migrations/ and 0047 pending; nothing else claims 0048.
-- Apply only through apps/api/src/operator/apply-pending-migration.ts (holds the fencing lease and writes the
-- _migrations ledger row in the same transaction), after explicit approval. Exactly one BEGIN;/COMMIT; pair.
-- Fencing: every new public table below receives mip_fence_* guards from the 0046 event trigger at CREATE TABLE;
-- nothing here disables, bypasses or alters a guard. The permissions INSERT is a guarded write, so the file
-- cannot be applied without a live owner lease — by design.
-- Additive only: five new tables, three functions, their triggers, three permission rows. No existing table,
-- row, role, role grant or user grant is changed. The new permissions are granted to nobody here.
-- Rollback (only while the new tables are empty): 0048_influencer_cards_rollback.sql.
BEGIN;

-- Uploaded identity images (logos, backgrounds). Validated by the API (PNG/JPEG/WebP magic bytes,
-- size and dimensions); never SVG. Immutable once stored, so a published template can never change
-- by its image changing underneath it.
CREATE TABLE influencer_card_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('logo','background')),
  mime          text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  bytes         bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  byte_size     integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  width         integer NOT NULL CHECK (width BETWEEN 16 AND 4096),
  height        integer NOT NULL CHECK (height BETWEEN 16 AND 4096),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name text CHECK (original_name IS NULL OR char_length(original_name) <= 200),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT influencer_card_assets_size_matches CHECK (byte_size = octet_length(bytes)),
  UNIQUE (kind, sha256)
);

-- A template: an editable draft plus a pointer to its latest published version.
CREATE TABLE influencer_card_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  description       text CHECK (description IS NULL OR char_length(description) <= 500),
  program_id        uuid REFERENCES programs(id),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_default        boolean NOT NULL DEFAULT false,
  draft_config      jsonb NOT NULL CHECK (jsonb_typeof(draft_config) = 'object'),
  draft_revision    integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_version integer CHECK (published_version IS NULL OR published_version > 0),
  created_by        uuid NOT NULL REFERENCES users(id),
  updated_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Only an active, published template can be a default.
  CONSTRAINT influencer_card_templates_default_shape CHECK (NOT is_default OR (status = 'active' AND published_version IS NOT NULL))
);
CREATE UNIQUE INDEX influencer_card_templates_name ON influencer_card_templates (lower(trim(name)));
-- At most one default per program, and one global default (program_id NULL).
CREATE UNIQUE INDEX influencer_card_templates_program_default ON influencer_card_templates (program_id) WHERE is_default AND program_id IS NOT NULL;
CREATE UNIQUE INDEX influencer_card_templates_global_default ON influencer_card_templates ((true)) WHERE is_default AND program_id IS NULL;

-- Published versions: an exact, frozen copy of the configuration. Never updated or deleted.
CREATE TABLE influencer_card_template_versions (
  template_id    uuid NOT NULL REFERENCES influencer_card_templates(id),
  version        integer NOT NULL CHECK (version > 0),
  config         jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  config_sha256  text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  note           text CHECK (note IS NULL OR char_length(note) <= 300),
  published_by   uuid NOT NULL REFERENCES users(id),
  published_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);
ALTER TABLE influencer_card_templates
  ADD CONSTRAINT influencer_card_templates_published_fk FOREIGN KEY (id, published_version)
  REFERENCES influencer_card_template_versions (template_id, version);

-- Export log, in two append-only parts:
--   influencer_card_exports        the REQUEST: who, which account, which program/template version, window, format.
--   influencer_card_export_events  what then happened, as reported by the requester's browser (the file is made there):
--     generated          the file was produced (pages, size, SHA-256 of its bytes);
--     failed             it was not (a short technical code, no free text);
--     handed_to_browser  the download was handed to the browser — NOT proof the file was saved on the device.
-- Nothing records "saved on the device": a browser cannot prove it. No post text, image, figure or personal data is stored.
CREATE TABLE influencer_card_exports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by      uuid NOT NULL REFERENCES users(id),
  idempotency_key   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  influencer_id     uuid NOT NULL REFERENCES tracked_influencers(id),
  -- The program the template was resolved for (the period filter, else the account's most linked program).
  program_id        uuid REFERENCES programs(id),
  program_filter_id uuid REFERENCES programs(id),
  template_id       uuid,
  template_version  integer,
  builtin_template  boolean NOT NULL,
  format            text NOT NULL CHECK (format IN ('png','a4-portrait','a4-landscape')),
  png_scale         smallint CHECK (png_scale IS NULL OR png_scale IN (2,3)),
  range_preset      text CHECK (range_preset IS NULL OR range_preset ~ '^[a-z0-9_]{1,20}$'),
  range_from        timestamptz NOT NULL,
  range_to          timestamptz NOT NULL,
  scope             text NOT NULL CHECK (scope IN ('all','relevant')),
  recent_limit      smallint NOT NULL CHECK (recent_limit BETWEEN 0 AND 50),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by, idempotency_key),
  CONSTRAINT influencer_card_exports_template_fk FOREIGN KEY (template_id, template_version)
    REFERENCES influencer_card_template_versions (template_id, version),
  CONSTRAINT influencer_card_exports_template_shape CHECK (builtin_template = (template_id IS NULL) AND (template_id IS NULL) = (template_version IS NULL)),
  CONSTRAINT influencer_card_exports_format_shape CHECK ((format = 'png') = (png_scale IS NOT NULL)),
  CONSTRAINT influencer_card_exports_range CHECK (range_from < range_to)
);
CREATE INDEX influencer_card_exports_user ON influencer_card_exports (requested_by, requested_at DESC);
CREATE INDEX influencer_card_exports_influencer ON influencer_card_exports (influencer_id, requested_at DESC);

CREATE TABLE influencer_card_export_events (
  id           bigserial PRIMARY KEY,
  export_id    uuid NOT NULL REFERENCES influencer_card_exports(id),
  event        text NOT NULL CHECK (event IN ('generated','failed','handed_to_browser')),
  pages        smallint CHECK (pages IS NULL OR pages BETWEEN 1 AND 500),
  file_bytes   integer CHECK (file_bytes IS NULL OR file_bytes BETWEEN 1 AND 209715200),
  file_sha256  text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  error_code   text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000),
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT influencer_card_export_events_shape CHECK (
    (event = 'generated' AND pages IS NOT NULL AND file_bytes IS NOT NULL AND file_sha256 IS NOT NULL AND error_code IS NULL) OR
    (event = 'failed' AND error_code IS NOT NULL AND pages IS NULL AND file_bytes IS NULL AND file_sha256 IS NULL) OR
    (event = 'handed_to_browser' AND pages IS NULL AND file_bytes IS NULL AND file_sha256 IS NULL AND error_code IS NULL))
);
-- One technical outcome per request (generated XOR failed), and at most one hand-off.
CREATE UNIQUE INDEX influencer_card_export_events_outcome ON influencer_card_export_events (export_id) WHERE event IN ('generated','failed');
CREATE UNIQUE INDEX influencer_card_export_events_handoff ON influencer_card_export_events (export_id) WHERE event = 'handed_to_browser';

-- Only the requester reports on a request, and a hand-off only follows a generated file.
CREATE FUNCTION influencer_card_export_event_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM influencer_card_exports e WHERE e.id = NEW.export_id AND e.requested_by = NEW.recorded_by) THEN
    RAISE EXCEPTION 'Only the requester records export events' USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'handed_to_browser' AND NOT EXISTS (
       SELECT 1 FROM influencer_card_export_events v WHERE v.export_id = NEW.export_id AND v.event = 'generated') THEN
    RAISE EXCEPTION 'A hand-off needs a generated file' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER influencer_card_export_events_check BEFORE INSERT ON influencer_card_export_events
  FOR EACH ROW EXECUTE FUNCTION influencer_card_export_event_check();

-- Frozen rows: published versions, uploaded assets and export records cannot be changed or removed.
CREATE FUNCTION influencer_card_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER influencer_card_template_versions_immutable BEFORE UPDATE OR DELETE ON influencer_card_template_versions
  FOR EACH ROW EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_template_versions_no_truncate BEFORE TRUNCATE ON influencer_card_template_versions
  FOR EACH STATEMENT EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_assets_immutable BEFORE UPDATE OR DELETE ON influencer_card_assets
  FOR EACH ROW EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_assets_no_truncate BEFORE TRUNCATE ON influencer_card_assets
  FOR EACH STATEMENT EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_exports_immutable BEFORE UPDATE OR DELETE ON influencer_card_exports
  FOR EACH ROW EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_exports_no_truncate BEFORE TRUNCATE ON influencer_card_exports
  FOR EACH STATEMENT EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_export_events_immutable BEFORE UPDATE OR DELETE ON influencer_card_export_events
  FOR EACH ROW EXECUTE FUNCTION influencer_card_reject_change();
CREATE TRIGGER influencer_card_export_events_no_truncate BEFORE TRUNCATE ON influencer_card_export_events
  FOR EACH STATEMENT EXECUTE FUNCTION influencer_card_reject_change();

-- A published version's number is always the next one for its template.
CREATE FUNCTION influencer_card_version_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> coalesce((SELECT max(version) FROM influencer_card_template_versions WHERE template_id = NEW.template_id), 0) + 1 THEN
    RAISE EXCEPTION 'Template versions must be consecutive' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER influencer_card_template_versions_sequence BEFORE INSERT ON influencer_card_template_versions
  FOR EACH ROW EXECUTE FUNCTION influencer_card_version_sequence();

-- Permission rows only. NO role_permissions / user_permissions rows: granting is a separate, approved change.
INSERT INTO permissions (key, domain, description_ar) VALUES
  ('influencer_cards:export', 'influencers', 'تصدير بطاقات المؤثرين (PNG وPDF)'),
  ('influencer_card_templates:read', 'influencers', 'عرض قوالب بطاقات المؤثرين وإصداراتها'),
  ('influencer_card_templates:manage', 'influencers', 'إنشاء قوالب بطاقات المؤثرين وتعديلها ونشرها وتعيين الافتراضي')
ON CONFLICT (key) DO NOTHING;

COMMIT;
