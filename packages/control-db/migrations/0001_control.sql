CREATE SCHEMA hl;
REVOKE ALL ON SCHEMA hl FROM PUBLIC;
GRANT USAGE ON SCHEMA hl TO hl_dispatcher, hl_api, hl_promoter;

CREATE TABLE hl.harness_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_sha256 text UNIQUE NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    config jsonb NOT NULL CHECK (config @> '{"schema_version":1}'),
    canonical_json bytea NOT NULL,
    yaml_bytes bytea NOT NULL CHECK (octet_length(yaml_bytes) BETWEEN 1 AND 16384),
    parent_id uuid REFERENCES hl.harness_versions,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hl.harness_channels (
    channel text PRIMARY KEY,
    active_version_id uuid NOT NULL REFERENCES hl.harness_versions,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hl.benchmark_tasks (
    benchmark_digest text NOT NULL CHECK (benchmark_digest ~ '^[0-9a-f]{64}$'),
    task_key text NOT NULL,
    split text NOT NULL CHECK (split IN ('dev','validation')),
    category text NOT NULL CHECK (category IN (
        'schema_discovery','multi_step_analytics','data_inconsistencies',
        'tool_failures','ambiguous_requests','efficiency'
    )),
    dataset_digest text NOT NULL CHECK (dataset_digest ~ '^[0-9a-f]{64}$'),
    variant_id text NOT NULL,
    input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (benchmark_digest, task_key),
    CHECK (split_part(task_key,'/',2) = split AND split_part(task_key,'/',3) = variant_id)
);
CREATE TABLE hl.experiments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_id uuid NOT NULL REFERENCES hl.harness_versions,
    channel text NOT NULL REFERENCES hl.harness_channels,
    channel_revision integer NOT NULL CHECK (channel_revision > 0),
    principal text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    mode text NOT NULL CHECK (mode IN ('fixture','live')),
    scope text NOT NULL CHECK (
        (mode = 'fixture' AND scope = 'demo_fixture') OR (mode = 'live' AND scope = 'full_live')
    ),
    status text NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued','running','completed','failed','cancelled')
    ),
    stage text NOT NULL DEFAULT 'diagnose' CHECK (
        stage IN ('diagnose','propose','screen','validate','report')
    ),
    manifest jsonb NOT NULL CHECK (manifest @> '{"schema_version":1}'),
    max_spend_micros bigint NOT NULL CHECK (max_spend_micros >= 0),
    reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
    spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
    budget_exhausted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (principal,idempotency_key)
);
CREATE TABLE hl.experiment_arms (
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    harness_id uuid NOT NULL REFERENCES hl.harness_versions,
    role text NOT NULL CHECK (role IN ('baseline','candidate')),
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
    disposition text NOT NULL,
    PRIMARY KEY (experiment_id,harness_id),
    UNIQUE (experiment_id,ordinal)
);
CREATE UNIQUE INDEX one_baseline ON hl.experiment_arms(experiment_id) WHERE role = 'baseline';
CREATE TABLE hl.task_runs (
    id uuid PRIMARY KEY,
    experiment_id uuid NOT NULL,
    harness_id uuid NOT NULL,
    benchmark_digest text NOT NULL,
    task_key text NOT NULL,
    stage text NOT NULL CHECK (stage IN ('diagnose','screen','validate')),
    repeat smallint NOT NULL CHECK (repeat BETWEEN 1 AND 3),
    manifest jsonb NOT NULL CHECK (manifest @> '{"schema_version":1}'),
    result_status text NOT NULL DEFAULT 'pending' CHECK (result_status IN (
        'pending','answered','clarified','unable','unsafe','budget_exhausted','infrastructure_error','cancelled'
    )),
    envelope jsonb,
    answer jsonb,
    grade jsonb,
    replay_digest text,
    trace_digest text,
    latency_ms integer CHECK (latency_ms >= 0),
    input_tokens bigint CHECK (input_tokens >= 0),
    output_tokens bigint CHECK (output_tokens >= 0),
    tool_calls integer CHECK (tool_calls >= 0),
    safety_count integer CHECK (safety_count >= 0),
    cost_micros bigint CHECK (cost_micros >= 0),
    completed_at timestamptz,
    FOREIGN KEY (experiment_id,harness_id) REFERENCES hl.experiment_arms,
    FOREIGN KEY (benchmark_digest,task_key) REFERENCES hl.benchmark_tasks,
    UNIQUE (experiment_id,harness_id,stage,task_key,repeat),
    UNIQUE (experiment_id,id),
    CHECK ((result_status = 'pending') = (completed_at IS NULL)),
    CHECK ((result_status = 'pending') = (grade IS NULL))
);
CREATE TABLE hl.trace_events (
    run_id uuid NOT NULL REFERENCES hl.task_runs,
    seq integer NOT NULL CHECK (seq BETWEEN 0 AND 10000),
    kind text NOT NULL,
    outcome_code text NOT NULL,
    elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
    correlation_id text,
    payload jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id,seq)
);
CREATE TABLE hl.failure_patterns (
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    signature text NOT NULL,
    count integer NOT NULL CHECK (count > 0),
    evidence_refs jsonb NOT NULL,
    summary jsonb NOT NULL,
    PRIMARY KEY (experiment_id,signature)
);
CREATE TABLE hl.optimization_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
    parent_id uuid NOT NULL REFERENCES hl.harness_versions,
    result_harness_id uuid REFERENCES hl.harness_versions,
    patch jsonb,
    rejected_summary text,
    rationale text,
    evidence_refs jsonb NOT NULL,
    status text NOT NULL,
    reason text,
    UNIQUE (experiment_id,ordinal)
);
CREATE TABLE hl.evaluation_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid NOT NULL,
    harness_id uuid NOT NULL,
    scope text NOT NULL CHECK (scope IN ('dev_fixture','validation')),
    policy_version text NOT NULL,
    roster_digest text NOT NULL,
    metrics_and_gates jsonb NOT NULL CHECK (metrics_and_gates @> '{"schema_version":1}'),
    evidence_digest text NOT NULL,
    report_digest text UNIQUE NOT NULL,
    complete boolean NOT NULL,
    winner boolean NOT NULL CHECK (NOT winner OR complete),
    FOREIGN KEY (experiment_id,harness_id) REFERENCES hl.experiment_arms,
    UNIQUE (experiment_id,harness_id,scope)
);
CREATE TABLE hl.promotion_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid REFERENCES hl.experiments,
    report_id uuid REFERENCES hl.evaluation_reports,
    channel text NOT NULL REFERENCES hl.harness_channels,
    kind text NOT NULL CHECK (kind IN ('promote','reject','rollback')),
    actor text NOT NULL,
    reason text NOT NULL,
    idempotency_key text NOT NULL,
    expected_revision integer NOT NULL,
    current_revision integer NOT NULL,
    from_version_id uuid NOT NULL REFERENCES hl.harness_versions,
    to_version_id uuid NOT NULL REFERENCES hl.harness_versions,
    evidence_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor,idempotency_key)
);
CREATE TABLE hl.published_experiments (
    experiment_id uuid PRIMARY KEY REFERENCES hl.experiments,
    actor text NOT NULL,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hl.work_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid NOT NULL REFERENCES hl.experiments,
    work_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('execute_task','analyze_and_propose','compare_and_advance')),
    run_id uuid UNIQUE,
    result_ref uuid,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
    generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
    fence integer NOT NULL DEFAULT 0 CHECK (fence >= 0),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    lease_until timestamptz,
    lease_token uuid,
    next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    effect_started boolean NOT NULL DEFAULT false,
    reservation_micros bigint CHECK (reservation_micros >= 0),
    graph_version text,
    input_digest text CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY (experiment_id,run_id) REFERENCES hl.task_runs(experiment_id,id),
    UNIQUE (experiment_id,work_key),
    CHECK ((kind = 'execute_task') = (run_id IS NOT NULL)),
    CHECK ((state = 'running') = (lease_until IS NOT NULL AND lease_token IS NOT NULL))
);
CREATE INDEX work_reconcile ON hl.work_items(state,next_at,lease_until);
CREATE TABLE hl.outbox (
    work_id uuid NOT NULL REFERENCES hl.work_items,
    generation integer NOT NULL CHECK (generation > 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz,
    PRIMARY KEY (work_id,generation)
);
CREATE INDEX outbox_due ON hl.outbox(available_at) WHERE sent_at IS NULL;
CREATE TABLE hl.graph_checkpoints (
    work_id uuid NOT NULL REFERENCES hl.work_items,
    thread_id text NOT NULL,
    seq smallint NOT NULL CHECK (seq BETWEEN 0 AND 119),
    write_key text NOT NULL,
    graph_version text NOT NULL,
    state_version smallint NOT NULL CHECK (state_version = 1),
    input_digest text NOT NULL,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 524288),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (work_id,seq,write_key)
);
CREATE TABLE hl.graph_projections (
    work_id uuid PRIMARY KEY REFERENCES hl.work_items,
    run_id uuid UNIQUE REFERENCES hl.task_runs,
    projection jsonb NOT NULL CHECK (projection @> '{"schema_version":1}'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION hl.immutable_row() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'immutable history' USING ERRCODE = '55000';
END $$;

CREATE FUNCTION hl.guard_task_run() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.result_status <> 'pending'
       OR (to_jsonb(OLD) - ARRAY['result_status','envelope','answer','grade','replay_digest',
            'trace_digest','latency_ms','input_tokens','output_tokens','tool_calls','safety_count',
            'cost_micros','completed_at'])
       <> (to_jsonb(NEW) - ARRAY['result_status','envelope','answer','grade','replay_digest',
            'trace_digest','latency_ms','input_tokens','output_tokens','tool_calls','safety_count',
            'cost_micros','completed_at'])
       OR (OLD.envelope IS NOT NULL AND OLD.envelope IS DISTINCT FROM NEW.envelope)
    THEN
        RAISE EXCEPTION 'immutable task history' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER task_run_history BEFORE UPDATE ON hl.task_runs
FOR EACH ROW EXECUTE FUNCTION hl.guard_task_run();

CREATE FUNCTION hl.guard_experiment() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
    IF (to_jsonb(OLD) - ARRAY['status','stage','reserved_micros','spent_micros','budget_exhausted','completed_at'])
       <> (to_jsonb(NEW) - ARRAY['status','stage','reserved_micros','spent_micros','budget_exhausted','completed_at'])
    THEN
        RAISE EXCEPTION 'immutable experiment manifest' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER experiment_manifest BEFORE UPDATE ON hl.experiments
FOR EACH ROW EXECUTE FUNCTION hl.guard_experiment();

DO $$
DECLARE relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY[
        'harness_versions','benchmark_tasks','trace_events','evaluation_reports',
        'promotion_decisions','graph_projections'
    ] LOOP
        EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hl.%I
                        FOR EACH ROW EXECUTE FUNCTION hl.immutable_row()', relation);
    END LOOP;
END $$;

GRANT SELECT ON hl.harness_channels TO hl_dispatcher;
GRANT SELECT, INSERT ON hl.harness_versions, hl.benchmark_tasks, hl.trace_events,
    hl.failure_patterns, hl.optimization_proposals, hl.evaluation_reports,
    hl.graph_projections TO hl_dispatcher;
GRANT SELECT, INSERT, UPDATE ON hl.experiments, hl.experiment_arms, hl.task_runs,
    hl.work_items, hl.outbox TO hl_dispatcher;
GRANT SELECT, INSERT, DELETE ON hl.graph_checkpoints TO hl_dispatcher;
REVOKE ALL ON FUNCTION hl.immutable_row(), hl.guard_task_run(), hl.guard_experiment() FROM PUBLIC;
