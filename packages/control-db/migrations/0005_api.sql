CREATE TABLE hl.public_experiments (
    experiment_id uuid PRIMARY KEY REFERENCES hl.experiments,
    principal text NOT NULL CHECK (principal LIKE 'public:%'),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deadline timestamptz
);
CREATE INDEX public_starts ON hl.public_experiments(started_at);
CREATE INDEX public_session ON hl.public_experiments(principal);
GRANT SELECT, INSERT ON hl.public_experiments TO hl_dispatcher;
GRANT UPDATE (deadline) ON hl.public_experiments TO hl_dispatcher;

CREATE TABLE hl.api_actions (
    actor text NOT NULL,
    command text NOT NULL CHECK (command IN ('cancel','publish')),
    idempotency_key text NOT NULL,
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    response jsonb NOT NULL,
    PRIMARY KEY (actor,command,idempotency_key)
);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hl.api_actions
FOR EACH ROW EXECUTE FUNCTION hl.immutable_row();
GRANT SELECT, INSERT ON hl.api_actions TO hl_dispatcher;

CREATE VIEW hl.api_experiments AS
SELECT e.id,e.principal,e.channel,e.channel_revision,c.revision AS active_revision,e.status,e.stage,e.scope,e.mode,
    v.content_sha256 AS baseline_hash,e.created_at,e.completed_at,
    p.experiment_id IS NOT NULL AS published,
    (SELECT count(*)::int FROM hl.task_runs r WHERE r.experiment_id=e.id) AS scheduled_runs,
    (SELECT count(*)::int FROM hl.task_runs r WHERE r.experiment_id=e.id
        AND r.result_status <> 'pending') AS terminal_runs
FROM hl.experiments e JOIN hl.harness_versions v ON v.id=e.baseline_id
JOIN hl.harness_channels c ON c.channel=e.channel
LEFT JOIN hl.published_experiments p ON p.experiment_id=e.id;

CREATE VIEW hl.api_arms AS
SELECT a.experiment_id,a.harness_id,a.role,a.ordinal,a.disposition,v.content_sha256 AS hash
FROM hl.experiment_arms a JOIN hl.harness_versions v ON v.id=a.harness_id;

CREATE VIEW hl.api_runs AS
SELECT r.experiment_id,r.id AS run_id,r.task_key,r.stage,r.repeat,r.result_status AS result,
    r.grade,v.content_sha256 AS harness_hash
FROM hl.task_runs r JOIN hl.harness_versions v ON v.id=r.harness_id;

CREATE VIEW hl.api_trace AS
SELECT t.run_id,t.seq,t.kind,t.outcome_code,t.elapsed_ms::int,t.correlation_id,t.payload
FROM hl.trace_events t;

CREATE VIEW hl.api_graphs AS
SELECT w.experiment_id,g.run_id,g.projection FROM hl.graph_projections g
JOIN hl.work_items w ON w.id=g.work_id;

CREATE VIEW hl.api_reports AS
SELECT experiment_id,harness_id,scope,metrics_and_gates AS report
FROM hl.evaluation_reports;

CREATE VIEW hl.api_proposals AS
SELECT p.experiment_id,p.ordinal,p.patch,p.rationale,p.evidence_refs,p.status,p.reason,
    p.expected_metric,p.direction,v.content_sha256 AS candidate_hash
FROM hl.optimization_proposals p LEFT JOIN hl.harness_versions v ON v.id=p.result_harness_id;

CREATE VIEW hl.api_harnesses AS
SELECT v.id,v.content_sha256 AS hash,p.content_sha256 AS parent_hash,v.config,
    EXISTS (SELECT 1 FROM hl.harness_channels WHERE active_version_id=v.id
            AND channel='fixture') AS fixture_active,
    EXISTS (SELECT 1 FROM hl.harness_channels WHERE active_version_id=v.id
            AND channel='production') AS production_active
FROM hl.harness_versions v LEFT JOIN hl.harness_versions p ON p.id=v.parent_id;

CREATE VIEW hl.api_decisions AS
SELECT d.experiment_id,d.kind,d.current_revision,d.created_at,d.actor,d.reason,
    f.content_sha256 AS from_hash,t.content_sha256 AS to_hash
FROM hl.promotion_decisions d JOIN hl.harness_versions f ON f.id=d.from_version_id
JOIN hl.harness_versions t ON t.id=d.to_version_id;

GRANT SELECT ON hl.api_experiments,hl.api_arms,hl.api_runs,hl.api_trace,hl.api_graphs,
    hl.api_reports,hl.api_proposals,hl.api_harnesses,hl.api_decisions TO hl_api;

CREATE FUNCTION hl.publish_example(p_id uuid,p_actor text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
    existing hl.api_actions%ROWTYPE;
    result jsonb;
BEGIN
    IF p_actor IS NULL OR p_actor NOT LIKE 'operator:%'
       OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{1,100}$'
    THEN RETURN jsonb_build_object('code','invalid_request'); END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_actor,'publish',p_key)::text,5521));
    SELECT * INTO existing FROM hl.api_actions
      WHERE actor=p_actor AND command='publish' AND idempotency_key=p_key;
    IF FOUND THEN
        IF existing.experiment_id IS DISTINCT FROM p_id THEN
            RETURN jsonb_build_object('code','idempotency_conflict');
        END IF;
        RETURN existing.response;
    END IF;

    PERFORM 1 FROM hl.experiments WHERE id=p_id AND status IN ('completed','failed') FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM hl.trial_reports WHERE experiment_id=p_id) THEN
        RETURN jsonb_build_object('code','publish_unavailable');
    END IF;

    INSERT INTO hl.published_experiments VALUES(p_id,p_actor,clock_timestamp())
        ON CONFLICT (experiment_id) DO NOTHING;
    result := jsonb_build_object('id',p_id,'published',true);
    INSERT INTO hl.api_actions VALUES (p_actor,'publish',p_key,p_id,result);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION hl.publish_example(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hl.publish_example(uuid,text,text) TO hl_api;
