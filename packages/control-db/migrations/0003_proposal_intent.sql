ALTER TABLE hl.optimization_proposals
    ADD COLUMN expected_metric text CHECK (expected_metric IN (
        'success_rate','invalid_sql_rate','tool_calls_per_success','recovery_rate','cost_per_success'
    )),
    ADD COLUMN direction text CHECK (direction IN ('increase','decrease'));
