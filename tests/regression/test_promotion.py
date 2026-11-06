import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
import rfc8785
from harnesslab_contracts.replay import digest
from harnesslab_eval.comparison import compare
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.types.json import Jsonb
from test_gates import example

from scripts.db_migrate import migrate


@pytest.fixture
def review_db():
    admin_dsn = os.environ.get(
        "CONTROL_FIXTURE_ADMIN_DSN",
        "postgresql://hl_control_admin:fixture_control_admin@127.0.0.1:55432/harnesslab_control",
    )
    assert conninfo_to_dict(admin_dsn).get("host") in {"localhost", "127.0.0.1"}
    name = f"hl_review_{uuid4().hex[:16]}"
    grants = "\n".join(
        line
        for line in Path("infra/docker/control-init.sql").read_text().splitlines()
        if not line.startswith("CREATE ROLE")
    )
    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            with psycopg.connect(make_conninfo(admin_dsn, dbname=name)) as db:
                db.execute(grants.replace("harnesslab_control", name))
            migrator = make_conninfo(
                admin_dsn, dbname=name, user="hl_migrator", password="fixture_migrator"
            )
            promoter = make_conninfo(
                admin_dsn, dbname=name, user="hl_promoter", password="fixture_promoter"
            )
            migrate(migrator)
            yield migrator, promoter
        finally:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def candidate_version(db, harness, baseline):
    harness = {**harness, "workflow": {**harness["workflow"], "verify_numeric_answers": True}}
    raw = rfc8785.dumps(harness)
    return db.execute(
        """INSERT INTO hl.harness_versions
              (content_sha256,config,canonical_json,yaml_bytes,parent_id)
           VALUES(%s,%s,%s,%s,%s) ON CONFLICT(content_sha256) DO NOTHING RETURNING id""",
        (digest(harness), Jsonb(harness), raw, raw, baseline),
    ).fetchone()[0]


def seed(
    db,
    harness,
    *,
    channel="promotion-test",
    revision=1,
    candidate=None,
    unsafe=False,
    corrupt=False,
):
    baseline, baseline_hash = db.execute(
        """SELECT c.active_version_id,v.content_sha256 FROM hl.harness_channels c
           JOIN hl.harness_versions v ON v.id=c.active_version_id WHERE c.channel='fixture'"""
    ).fetchone()
    candidate = candidate or candidate_version(db, harness, baseline)
    candidate_hash = db.execute(
        "SELECT content_sha256 FROM hl.harness_versions WHERE id=%s", (candidate,)
    ).fetchone()[0]
    db.execute(
        """INSERT INTO hl.harness_channels(channel,active_version_id,revision)
           VALUES(%s,%s,%s) ON CONFLICT DO NOTHING""",
        (channel, baseline, revision),
    )
    experiment = uuid4()
    manifest = {"schema_version": 1, "test": True}
    db.execute(
        """INSERT INTO hl.experiments(id,baseline_id,channel,channel_revision,principal,
          idempotency_key,request_hash,mode,scope,max_spend_micros,manifest,status,stage,completed_at)
        VALUES(%s,%s,%s,%s,'test',%s,%s,'fixture','demo_fixture',0,%s,'completed','report',now())""",
        (experiment, baseline, channel, revision, str(experiment), "0" * 64, Jsonb(manifest)),
    )
    db.execute(
        """INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
        VALUES(%s,%s,'baseline',0,'scheduled'),(%s,%s,'candidate',1,'shortlisted')""",
        (experiment, baseline, experiment, candidate),
    )
    request = example()
    roster = [
        {
            "task_key": cell["task_key"],
            "repeat": cell["repeat"],
            "harness_id": str(arm),
            "run_id": cell[side]["run_id"],
        }
        for cell in request["cells"]
        for side, arm in (("baseline", baseline), ("candidate", candidate))
    ]
    db.execute(
        "INSERT INTO hl.trial_stages(experiment_id,stage,roster,roster_digest) "
        "VALUES(%s,'validate',%s,%s)",
        (experiment, Jsonb(roster), digest(roster)),
    )
    request.update(
        experiment_id=str(experiment),
        baseline_hash=baseline_hash,
        candidate_hash=candidate_hash,
        manifest_digest=digest(manifest),
        roster_digest=digest(roster),
    )
    if unsafe:
        request["cells"][0]["candidate"]["safety_violations"] = 1
    report = compare(request)
    request["mode"] = "fixture"
    report.update(mode="fixture", winner=not unsafe, evidence_digest=digest(request))
    report.pop("report_digest")
    raw = rfc8785.dumps(report)
    report_digest = digest(report)
    report["report_digest"] = report_digest
    report_id = db.execute(
        """INSERT INTO hl.evaluation_reports(experiment_id,harness_id,scope,policy_version,
        roster_digest,metrics_and_gates,evidence_digest,report_digest,complete,winner,canonical_report)
        VALUES(%s,%s,'validation',%s,%s,%s,%s,%s,true,%s,%s) RETURNING id""",
        (
            experiment,
            candidate,
            report["policy_version"],
            report["roster_digest"],
            Jsonb(report),
            report["evidence_digest"],
            report_digest,
            not unsafe,
            raw,
        ),
    ).fetchone()[0]
    db.execute(
        "INSERT INTO hl.evaluation_evidence(report_id,request_bytes,manifest_bytes) "
        "VALUES(%s,%s,%s)",
        (report_id, b"{}" if corrupt else rfc8785.dumps(request), rfc8785.dumps(manifest)),
    )
    return experiment, candidate_hash, report_digest, baseline, candidate


def review(
    dsn,
    record,
    *,
    actor="reviewer",
    key="key",
    kind="promote",
    revision=1,
    channel="promotion-test",
    fixture=True,
    reason="Reviewed evidence",
):
    experiment, candidate_hash, report_digest, *_ = record
    with psycopg.connect(dsn) as db:
        params = (
            kind,
            channel,
            experiment,
            candidate_hash,
            report_digest,
            revision,
            actor,
            reason,
            key,
        )
        if fixture:
            return db.execute(
                "SELECT hl.review_internal(%s,%s,%s,%s,%s,%s,%s,%s,%s,true)", params
            ).fetchone()[0]
        return db.execute("SELECT hl.review(%s,%s,%s,%s,%s,%s,%s,%s,%s)", params).fetchone()[0]


def test_concurrent_promotion_stale_review_and_rollback(review_db, harness):
    migrator, _ = review_db
    with psycopg.connect(migrator) as db:
        record = seed(db, harness)
    with ThreadPoolExecutor(2) as executor:
        a, b = [
            executor.submit(review, migrator, record, key=key)
            for key in ("approval-a", "approval-b")
        ]
        results = {"approval-a": a.result(), "approval-b": b.result()}
    assert sorted(item["code"] for item in results.values()) == ["ok", "stale_revision"]
    key, approved = next((key, row) for key, row in results.items() if row["code"] == "ok")
    assert review(migrator, record, key=key) == approved
    assert review(migrator, record, key=key, reason="Changed") == {"code": "idempotency_conflict"}
    assert review(migrator, record, key="stale", revision=2) == {"code": "stale_baseline"}
    with psycopg.connect(migrator) as db:
        active = db.execute(
            "SELECT active_version_id,revision FROM hl.harness_channels "
            "WHERE channel='promotion-test'"
        ).fetchone()
        assert active == (record[4], 2)
        pinned = db.execute(
            """INSERT INTO hl.experiments(baseline_id,channel,channel_revision,principal,
               idempotency_key,request_hash,mode,scope,max_spend_micros,manifest)
            SELECT active_version_id,channel,revision,'test','in-flight',%s,
                   'fixture','demo_fixture',0,'{"schema_version":1}'
            FROM hl.harness_channels WHERE channel='promotion-test' RETURNING id""",
            ("0" * 64,),
        ).fetchone()[0]
    assert (
        review(migrator, (None, None, None), kind="rollback", key="back", revision=2)["revision"]
        == 3
    )
    with psycopg.connect(migrator) as db:
        assert db.execute(
            "SELECT active_version_id,revision FROM hl.harness_channels "
            "WHERE channel='promotion-test'"
        ).fetchone() == (record[3], 3)
        assert db.execute(
            "SELECT baseline_id FROM hl.experiments WHERE id=%s", (record[0],)
        ).fetchone() == (record[3],)
        assert db.execute(
            "SELECT baseline_id FROM hl.experiments WHERE id=%s", (pinned,)
        ).fetchone() == (record[4],)


def test_unsafe_and_corrupt_reports_cannot_promote_and_rejection_is_recorded(review_db, harness):
    migrator, _ = review_db
    with psycopg.connect(migrator) as db:
        unsafe = seed(db, harness, unsafe=True)
        corrupt = seed(db, harness, candidate=unsafe[4], corrupt=True)
    assert review(migrator, unsafe, key="unsafe") == {"code": "report_ineligible"}
    assert review(migrator, corrupt, key="corrupt") == {"code": "report_integrity"}
    assert review(migrator, unsafe, kind="reject", key="reject")["revision"] == 1
    with psycopg.connect(migrator) as db:
        assert db.execute("SELECT kind,actor,reason FROM hl.promotion_decisions").fetchone() == (
            "reject",
            "reviewer",
            "Reviewed evidence",
        )


def test_production_role_cannot_promote_fixture_or_access_test_override(review_db, harness):
    migrator, promoter = review_db
    with psycopg.connect(migrator) as db:
        fixture_report = seed(db, harness, channel="production")
    assert review(promoter, fixture_report, fixture=False, channel="production") == {
        "code": "report_ineligible"
    }
    assert review(promoter, fixture_report, fixture=False) == {"code": "channel_forbidden"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        review(promoter, fixture_report)
    with psycopg.connect(promoter) as db:
        assert db.execute(
            "SELECT has_table_privilege('hl.harness_channels','UPDATE')"
        ).fetchone() == (False,)
