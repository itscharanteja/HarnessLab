from uuid import uuid4

import psycopg
from test_delivery import wait_for


def submit(dispatcher_node):
    return dispatcher_node(
        """
        import { controlPool } from "@harnesslab/control-db";
        import { submitTrial } from "./src/trials.ts";
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        const key=process.argv[1];
        const id=await submitTrial(pool,process.env.HL_DISPATCHER_ARTIFACT_DIR,key);
        const repeated=await submitTrial(pool,process.env.HL_DISPATCHER_ARTIFACT_DIR,key);
        await pool.end();
        console.log(JSON.stringify({id,repeated}));
    """,
        str(uuid4()),
    )


def read_trial(db, experiment):
    report, reserved, spent = db.execute(
        """
        SELECT r.report,e.reserved_micros,e.spent_micros FROM hl.trial_reports r
        JOIN hl.experiments e ON e.id=r.experiment_id WHERE e.id=%s
        """,
        (experiment,),
    ).fetchone()
    assert reserved == spent == 0
    assert report["reason"] == "ineligible_fixture"
    diagnose, screen = report["comparisons"]
    assert (diagnose["stage"], screen["stage"]) == ("diagnose", "screen")
    assert diagnose["complete"] and screen["complete"]
    assert len(diagnose["cells"]) == 6 and len(screen["cells"]) == 18
    assert {cell["run_id"] for cell in diagnose["cells"]} <= {
        cell["run_id"] for cell in screen["cells"]
    }
    success = {row["role"]: row["successes"] for row in diagnose["arms"] if row["attempted"]}
    assert success == {"baseline": 2}
    assert sorted(row["successes"] for row in screen["arms"]) == [2, 4, 4]
    assert db.execute(
        """
        SELECT signature,count FROM hl.failure_patterns WHERE experiment_id=%s ORDER BY signature
        """,
        (experiment,),
    ).fetchall() == [("schema_before_discovery", 2), ("unrecovered_fault", 2)]
    assert db.execute(
        """
        SELECT count(*) FROM hl.optimization_proposals WHERE experiment_id=%s AND status='accepted'
        """,
        (experiment,),
    ).fetchone() == (2,)
    assert db.execute(
        """
        SELECT count(*) FROM hl.graph_checkpoints c JOIN hl.work_items w ON w.id=c.work_id
        WHERE w.experiment_id=%s AND c.write_key='optimizer_validated'
        """,
        (experiment,),
    ).fetchone() == (1,)
    assert db.execute(
        """
        SELECT count(*) FROM hl.graph_projections p JOIN hl.work_items w ON w.id=p.work_id
        WHERE w.experiment_id=%s AND p.projection->>'graph_kind'='optimizer'
        """,
        (experiment,),
    ).fetchone() == (1,)
    comparisons = db.execute(
        """
        SELECT er.metrics_and_gates FROM hl.evaluation_reports er
        JOIN hl.evaluation_evidence proof ON proof.report_id=er.id
        WHERE er.experiment_id=%s AND er.scope='dev_fixture'
        """,
        (experiment,),
    ).fetchall()
    assert len(comparisons) == 2
    for (comparison,) in comparisons:
        assert comparison["complete"] and not comparison["winner"]
        assert comparison["baseline"]["successes"] == 2
        assert comparison["candidate"]["successes"] == 4
        assert comparison["gates"][0]["reason"] == "ineligible_fixture"
    return [(row["hash"], row["successes"], row["calls"]) for row in screen["arms"]]


def test_fixture_trials_match_and_reuse_diagnosis(control_dsn, dispatcher_node):
    with psycopg.connect(control_dsn, autocommit=True) as db:
        summaries = []
        for _ in range(2):
            created = submit(dispatcher_node)
            assert created["id"] == created["repeated"]
            assert wait_for(db, created["id"], seconds=90) == "completed"
            summaries.append(read_trial(db, created["id"]))
        assert summaries[0] == summaries[1]


def test_rejected_optimizer_disposition_is_audited(control_dsn, dispatcher_node, work_case):
    case = work_case()
    check = dispatcher_node(
        """
        import {controlPool,transaction} from "@harnesslab/control-db";
        import {persistProposals} from "./src/trials.ts";
        const id=process.argv[1];
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        await transaction(pool,async(db)=>{
          const {rows:[exp]}=await db.query("SELECT * FROM hl.experiments WHERE id=$1",[id]);
          await persistProposals(db,id,exp,{clusters:[]},{dispositions:[{
            ordinal:0,proposal:null,reason:"malformed_proposal",candidate_view_digest:null
          }]});
        });
        await pool.end();
        console.log(JSON.stringify(true));
    """,
        case["experiment"],
    )
    assert check
    with psycopg.connect(control_dsn) as db:
        assert db.execute(
            """
            SELECT status,reason,patch,result_harness_id FROM hl.optimization_proposals
            WHERE experiment_id=%s
        """,
            (case["experiment"],),
        ).fetchone() == ("rejected", "malformed_proposal", None, None)
        assert db.execute(
            """
            SELECT report->>'reason',report->>'eligibility' FROM hl.trial_reports
            WHERE experiment_id=%s
        """,
            (case["experiment"],),
        ).fetchone() == ("no_valid_proposal", "ineligible_fixture")
