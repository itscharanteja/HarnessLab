ALTER TABLE hl.work_items ADD COLUMN worker_deadline timestamptz;

CREATE TABLE hl.trial_stages (
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    stage text NOT NULL CHECK (stage IN ('diagnose','screen','validate')),
    roster jsonb NOT NULL CHECK (jsonb_typeof(roster) = 'array'),
    roster_digest text NOT NULL CHECK (roster_digest ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (experiment_id,stage)
);

CREATE TABLE hl.trial_reports (
    experiment_id uuid PRIMARY KEY REFERENCES hl.experiments,
    report jsonb NOT NULL CHECK (report @> '{"schema_version":1}'),
    report_digest text NOT NULL CHECK (report_digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE hl.optimizer_usage (
    work_id uuid PRIMARY KEY REFERENCES hl.work_items,
    usage jsonb,
    cost_micros bigint NOT NULL CHECK (cost_micros >= 0)
);

CREATE TRIGGER trial_stage_immutable BEFORE UPDATE OR DELETE ON hl.trial_stages
FOR EACH ROW EXECUTE FUNCTION hl.immutable_row();
CREATE TRIGGER trial_report_immutable BEFORE UPDATE OR DELETE ON hl.trial_reports
FOR EACH ROW EXECUTE FUNCTION hl.immutable_row();
CREATE TRIGGER optimizer_usage_immutable BEFORE UPDATE OR DELETE ON hl.optimizer_usage
FOR EACH ROW EXECUTE FUNCTION hl.immutable_row();
GRANT SELECT, INSERT ON hl.trial_stages, hl.trial_reports, hl.optimizer_usage TO hl_dispatcher;
