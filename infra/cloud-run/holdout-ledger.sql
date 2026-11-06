-- Apply in the dedicated holdout ledger database with the operator's schema owner.
-- Provision the hl_holdout_ledger LOGIN role separately.
DO $$
BEGIN
    EXECUTE format('REVOKE CONNECT,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO hl_holdout_ledger',current_database());
END $$;
CREATE SCHEMA hl_holdout_ledger;
REVOKE ALL ON SCHEMA hl_holdout_ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA hl_holdout_ledger TO hl_holdout_ledger;

CREATE TABLE hl_holdout_ledger.evaluations (
    digest text PRIMARY KEY, seal text NOT NULL, report text
);
CREATE TABLE hl_holdout_ledger.runs (
    digest text NOT NULL REFERENCES hl_holdout_ledger.evaluations(digest),
    run_id text NOT NULL, state text NOT NULL CHECK (state IN ('running','received','done')),
    deadline text NOT NULL, envelope text, result text, charged bigint NOT NULL DEFAULT 0,
    PRIMARY KEY(digest,run_id)
);
GRANT SELECT,INSERT ON hl_holdout_ledger.evaluations,hl_holdout_ledger.runs TO hl_holdout_ledger;
GRANT UPDATE (report) ON hl_holdout_ledger.evaluations TO hl_holdout_ledger;
GRANT UPDATE (state,envelope,result,charged) ON hl_holdout_ledger.runs TO hl_holdout_ledger;

CREATE FUNCTION hl_holdout_ledger.guard_terminal() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
    IF to_jsonb(OLD)->>'report' IS NOT NULL OR to_jsonb(OLD)->>'state' = 'done' THEN
        RAISE EXCEPTION 'immutable holdout result' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER holdout_report_history BEFORE UPDATE ON hl_holdout_ledger.evaluations
FOR EACH ROW EXECUTE FUNCTION hl_holdout_ledger.guard_terminal();
CREATE TRIGGER holdout_run_history BEFORE UPDATE ON hl_holdout_ledger.runs
FOR EACH ROW EXECUTE FUNCTION hl_holdout_ledger.guard_terminal();
REVOKE ALL ON FUNCTION hl_holdout_ledger.guard_terminal() FROM PUBLIC;
