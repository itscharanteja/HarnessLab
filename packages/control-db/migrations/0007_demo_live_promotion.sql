CREATE OR REPLACE FUNCTION hl.review_internal(
    p_kind text, p_channel text, p_experiment uuid, p_candidate text, p_report text,
    p_expected integer, p_actor text, p_reason text, p_key text, p_test boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
    c hl.harness_channels%ROWTYPE;
    e hl.experiments%ROWTYPE;
    r hl.evaluation_reports%ROWTYPE;
    proof hl.evaluation_evidence%ROWTYPE;
    previous hl.promotion_decisions%ROWTYPE;
    target uuid;
    evidence text;
    request_hash text;
    new_revision integer;
    decision uuid;
    body jsonb;
    request_body jsonb;
    stage_roster text;
BEGIN
    IF p_kind IS NULL OR p_kind NOT IN ('promote','reject','rollback')
       OR p_channel IS NULL OR p_channel !~ '^[a-z0-9-]{1,60}$'
       OR p_expected IS NULL OR p_expected < 1
       OR p_actor IS NULL OR char_length(p_actor) NOT BETWEEN 1 AND 200
       OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 600
       OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{1,100}$'
       OR (p_kind = 'rollback' AND (p_experiment IS NOT NULL OR p_candidate IS NOT NULL OR p_report IS NOT NULL))
       OR (p_kind <> 'rollback' AND (p_experiment IS NULL OR p_candidate IS NULL
            OR p_report IS NULL OR p_candidate !~ '^[0-9a-f]{64}$' OR p_report !~ '^[0-9a-f]{64}$'))
    THEN RETURN jsonb_build_object('code','invalid_review'); END IF;

    IF p_test IS DISTINCT FROM (p_channel = 'promotion-test')
       OR (NOT p_test AND p_kind <> 'reject' AND p_channel <> 'production')
    THEN RETURN jsonb_build_object('code','channel_forbidden'); END IF;

    request_hash := encode(sha256(convert_to(jsonb_build_array(
        p_kind,p_channel,p_experiment,p_candidate,p_report,p_expected,btrim(p_reason)
    )::text,'UTF8')),'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_actor,p_key)::text,5315));
    SELECT * INTO previous FROM hl.promotion_decisions WHERE actor=p_actor AND idempotency_key=p_key;
    IF FOUND THEN
        IF previous.request_digest IS DISTINCT FROM request_hash THEN
            RETURN jsonb_build_object('code','idempotency_conflict');
        END IF;
        RETURN jsonb_build_object('code','ok','decision_id',previous.id,'revision',previous.current_revision);
    END IF;

    SELECT * INTO c FROM hl.harness_channels WHERE channel=p_channel FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','channel_unavailable'); END IF;
    IF c.revision <> p_expected THEN RETURN jsonb_build_object('code','stale_revision'); END IF;
    target := c.active_version_id;
    new_revision := c.revision;

    IF p_kind = 'rollback' THEN
        SELECT * INTO previous FROM hl.promotion_decisions
        WHERE channel=p_channel AND kind IN ('promote','rollback') AND current_revision=c.revision;
        IF NOT FOUND OR previous.to_version_id <> c.active_version_id THEN
            RETURN jsonb_build_object('code','rollback_unavailable');
        END IF;
        target := previous.from_version_id;
        evidence := previous.evidence_digest;
    ELSE
        SELECT * INTO e FROM hl.experiments WHERE id=p_experiment AND channel=p_channel;
        IF NOT FOUND THEN RETURN jsonb_build_object('code','experiment_unavailable'); END IF;
        SELECT er.* INTO r FROM hl.evaluation_reports er
        JOIN hl.harness_versions v ON v.id=er.harness_id
        WHERE er.experiment_id=p_experiment AND er.report_digest=p_report
            AND v.content_sha256=p_candidate;
        IF NOT FOUND THEN RETURN jsonb_build_object('code','report_mismatch'); END IF;
        SELECT * INTO proof FROM hl.evaluation_evidence WHERE report_id=r.id;
        SELECT roster_digest INTO stage_roster FROM hl.trial_stages WHERE experiment_id=e.id
            AND stage=CASE WHEN r.scope='validation' THEN 'validate' ELSE 'screen' END;
        body := r.metrics_and_gates;
        IF proof.report_id IS NULL OR r.canonical_report IS NULL
           OR r.policy_version <> 'paired-gate-v1'
           OR r.roster_digest IS DISTINCT FROM stage_roster
           OR r.evidence_digest <> encode(sha256(proof.request_bytes),'hex')
           OR r.report_digest <> encode(sha256(r.canonical_report),'hex')
           OR convert_from(r.canonical_report,'UTF8')::jsonb IS DISTINCT FROM (body - 'report_digest')
           OR convert_from(proof.manifest_bytes,'UTF8')::jsonb IS DISTINCT FROM e.manifest
           OR body->>'manifest_digest' IS DISTINCT FROM encode(sha256(proof.manifest_bytes),'hex')
           OR body->>'report_digest' IS DISTINCT FROM r.report_digest
           OR body->>'evidence_digest' IS DISTINCT FROM r.evidence_digest
           OR body->>'roster_digest' IS DISTINCT FROM r.roster_digest
           OR body->>'policy_version' IS DISTINCT FROM r.policy_version
           OR body->>'experiment_id' IS DISTINCT FROM e.id::text
           OR body->>'candidate_hash' IS DISTINCT FROM p_candidate
           OR body->>'baseline_hash' IS DISTINCT FROM (
               SELECT content_sha256 FROM hl.harness_versions WHERE id=e.baseline_id)
           OR body->>'mode' IS DISTINCT FROM e.mode OR body->>'scope' IS DISTINCT FROM r.scope
           OR body->'winner' IS DISTINCT FROM to_jsonb(r.winner)
           OR body->'complete' IS DISTINCT FROM to_jsonb(r.complete)
        THEN RETURN jsonb_build_object('code','report_integrity'); END IF;
        request_body := convert_from(proof.request_bytes,'UTF8')::jsonb;
        IF (request_body - ARRAY['provenance_valid','candidate_dev_safe','seed','cells'])
           IS DISTINCT FROM (body - ARRAY['policy_version','evidence_digest','report_digest',
                    'complete','winner','baseline','candidate','paired','categories','uncertainty','gates'])
        THEN RETURN jsonb_build_object('code','report_integrity'); END IF;

        evidence := r.evidence_digest;
        IF p_kind = 'promote' THEN
            IF c.active_version_id <> e.baseline_id OR c.revision <> e.channel_revision THEN
                RETURN jsonb_build_object('code','stale_baseline');
            END IF;
            IF e.status <> 'completed' OR e.budget_exhausted OR e.reserved_micros <> 0
               OR r.scope <> 'validation' OR NOT r.complete OR NOT r.winner
               OR (NOT p_test AND (e.mode <> 'live' OR e.scope <> 'full_live'))
               OR (p_test AND e.mode <> 'fixture')
               OR request_body->'provenance_valid' IS DISTINCT FROM 'true'::jsonb
               OR request_body->'candidate_dev_safe' IS DISTINCT FROM 'true'::jsonb
               OR body->'baseline'->'scheduled' NOT IN ('90'::jsonb, '6'::jsonb)
               OR body->'candidate'->'scheduled' NOT IN ('90'::jsonb, '6'::jsonb)
               OR NOT COALESCE(body->'gates' @> '[
                 {"gate":"provenance","status":"passed"},
                 {"gate":"safety","status":"passed"},
                 {"gate":"regressions","status":"passed"}
               ]',false)
               OR NOT COALESCE(body->'gates' @> '[{"gate":"quality","status":"passed"}]'
                   OR body->'gates' @> '[{"gate":"efficiency","status":"passed"}]',false)
               OR NOT EXISTS (SELECT 1 FROM hl.experiment_arms WHERE experiment_id=e.id
                    AND harness_id=r.harness_id AND role='candidate' AND disposition='shortlisted')
               OR EXISTS (SELECT 1 FROM hl.promotion_decisions WHERE report_id=r.id AND kind='reject')
            THEN RETURN jsonb_build_object('code','report_ineligible'); END IF;
            target := r.harness_id;
        END IF;
    END IF;

    IF p_kind <> 'reject' THEN
        new_revision := c.revision+1;
        UPDATE hl.harness_channels SET active_version_id=target,revision=new_revision,
            activated_at=clock_timestamp() WHERE channel=p_channel;
    END IF;
    INSERT INTO hl.promotion_decisions(experiment_id,report_id,channel,kind,actor,reason,idempotency_key,
        expected_revision,current_revision,from_version_id,to_version_id,evidence_digest,request_digest)
    VALUES(p_experiment,r.id,p_channel,p_kind,p_actor,btrim(p_reason),p_key,p_expected,new_revision,
        c.active_version_id,target,evidence,request_hash)
    RETURNING id INTO decision;
    RETURN jsonb_build_object('code','ok','decision_id',decision,'revision',new_revision);
END $$;
