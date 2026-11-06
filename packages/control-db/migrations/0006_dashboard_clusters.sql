CREATE VIEW hl.api_clusters AS
SELECT experiment_id,signature,count,evidence_refs
FROM hl.failure_patterns;

GRANT SELECT ON hl.api_clusters TO hl_api;
