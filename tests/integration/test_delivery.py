import os
import time
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from scripts.db_migrate import migrate


def wait_for(db, experiment, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = db.execute(
            "SELECT status FROM hl.experiments WHERE id=%s", (experiment,)
        ).fetchone()
        if status and status[0] in {"completed", "failed"}:
            return status[0]
        time.sleep(0.25)
    raise AssertionError("Fixture experiment did not terminate")


def test_bullmq_delivery_persists_and_replays_once(control_dsn, dispatcher_node):
    submitted = dispatcher_node(
        """
        import { controlPool } from "@harnesslab/control-db";
        import { submitFixture } from "./src/artifacts.ts";
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        const key=process.argv[1], root=process.env.HL_DISPATCHER_ARTIFACT_DIR;
        const a=await submitFixture(pool,root,key), b=await submitFixture(pool,root,key);
        await pool.end();
        console.log(JSON.stringify({a,b}));
    """,
        str(uuid4()),
    )
    assert submitted["a"] == submitted["b"]
    with psycopg.connect(control_dsn, autocommit=True) as db:
        assert wait_for(db, submitted["a"]) == "completed"
        run, envelope, grade, replay, spend, work_id, gen = db.execute(
            """
            SELECT r.id,r.envelope,r.grade,r.replay_digest,r.cost_micros,w.id,w.generation
            FROM hl.task_runs r JOIN hl.work_items w ON w.run_id=r.id
            WHERE r.experiment_id=%s
        """,
            (submitted["a"],),
        ).fetchone()
        assert grade["success"] and spend == 0
        assert envelope["answer"]["findings"][0]["value"] == 6
        events = db.execute(
            "SELECT seq,kind FROM hl.trace_events WHERE run_id=%s ORDER BY seq", (run,)
        ).fetchall()
        assert events[-1] == (len(envelope["events"]), "grade")
        assert db.execute(
            "SELECT projection->>'graph_version' FROM hl.graph_projections WHERE run_id=%s", (run,)
        ).fetchone() == ("worker_v1",)

        check = dispatcher_node(
            """
            import { Queue } from "bullmq";
            import { setTimeout } from "node:timers/promises";
            const parts=[];
            for await (const chunk of process.stdin) parts.push(chunk);
            const body=JSON.parse(Buffer.concat(parts));
            const result=await fetch(new URL("/internal/v1/grade-task",process.env.EVALUATOR_URL), {
              method:"POST",headers:{authorization:`Bearer ${process.env.HL_EVALUATOR_TOKEN}`,
              "content-type":"application/json"},body:JSON.stringify({schema_version:1,run:body.envelope})
            });
            const queue=new Queue("harnesslab-work-v1",{connection:{host:"redis",port:6379}});
            const id=`hl-${body.work_id}-${body.generation}`;
            const old=await queue.getJob(id);
            if (old && await old.isCompleted()) await old.remove();
            const job=await queue.add("work",{schema_version:1,work_id:body.work_id,
              generation:body.generation},{jobId:id});
            for (let i=0;i<80 && !(await job.isCompleted());i++) await setTimeout(100);
            const completed=await job.isCompleted();
            await queue.close();
            console.log(JSON.stringify({grade:await result.json(),completed}));
        """,
            payload={"envelope": envelope, "work_id": str(work_id), "generation": gen},
        )
        assert check["completed"]
        assert check["grade"]["replay_digest"] == replay and check["grade"]["grade"] == grade
        assert db.execute(
            "SELECT count(*) FROM hl.trace_events WHERE run_id=%s", (run,)
        ).fetchone() == (len(events),)


STORE = """
import { controlPool } from "@harnesslab/control-db";
import { claim, fail, finish, readRun, reclaim, reserveAndMark, saveEnvelope } from "./src/work.ts";
import { digest } from "./src/artifacts.ts";
import { replayTraceDigest } from "./src/accounting.ts";
const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
const [work_id]=process.argv.slice(1);
const ref={schema_version:1,work_id,generation:1};
const item=await claim(pool,ref);
if(!item) throw Error("Lease missing");
const pinned=await readRun(pool,item.run_id);
const reserved=await reserveAndMark(pool,item,pinned);
"""


def test_expired_paid_effect_charges_once_and_rejects_stale_worker(
    control_dsn, dispatcher_node, work_case
):
    case = work_case("live")
    outcome = dispatcher_node(
        STORE
        + """
        if(!reserved) throw Error("Reservation refused");
        await pool.query("UPDATE hl.work_items SET lease_until=clock_timestamp()"
          +" - interval '1 sec' WHERE id=$1",[item.id]);
        await reclaim(pool);
        await reclaim(pool);
        const reclaimed=await claim(pool,ref);
        let stale;
        try { await fail(pool,item,"retry"); } catch (error) { stale=error.code; }
        await pool.end();
        console.log(JSON.stringify({reclaimed,stale}));
    """,
        case["work_id"],
    )
    assert outcome == {"reclaimed": None, "stale": "stale_lease"}
    with psycopg.connect(control_dsn) as db:
        assert db.execute(
            "SELECT spent_micros,reserved_micros,status FROM hl.experiments WHERE id=%s",
            (case["experiment"],),
        ).fetchone() == (15000, 0, "failed")
        status, cost, grade = db.execute(
            "SELECT result_status,cost_micros,grade FROM hl.task_runs WHERE id=%s",
            (case["run_id"],),
        ).fetchone()
        assert status == "infrastructure_error" and cost == 15000
        assert "usage_unknown" in grade["reasons"]


def test_saved_worker_envelope_survives_retry_and_partial_roster_is_ineligible(
    control_dsn, dispatcher_node, work_case
):
    case = work_case(expected=2)
    check = dispatcher_node(
        STORE
        + """
        if(!reserved) throw Error("Reservation refused");
        const manifest=pinned.manifest;
        const events=[{run_id:manifest.run_id,seq:0,elapsed_ms:0,kind:"start",
          outcome_code:"started",correlation_id:null,payload:{task_key:manifest.task_key,config_hash:manifest.config_hash}}];
        const envelope={schema_version:1,manifest,events,answer:null,result:"unable",
          trace_digest:replayTraceDigest(events)};
        await saveEnvelope(pool,item,{schema_version:1,run:envelope,
          graph:{schema_version:1,graph_kind:"worker",graph_version:"worker_v1",events:[]}});
        await pool.query("UPDATE hl.work_items SET lease_until=clock_timestamp()"
          +" - interval '1 sec' WHERE id=$1",[item.id]);
        await reclaim(pool);
        const record=(await pool.query(
          "SELECT generation,state FROM hl.work_items WHERE id=$1",[item.id])).rows[0];
        await pool.query("UPDATE hl.outbox SET available_at=clock_timestamp()"
          +" + interval '1 day' WHERE work_id=$1",[item.id]);
        await pool.query(
          "UPDATE hl.work_items SET next_at=clock_timestamp() WHERE id=$1",[item.id]);
        const second=await claim(pool,{...ref,generation:2});
        const saved=(await readRun(pool,item.run_id)).envelope;
        const grade={schema_version:1,success:false,reasons:["unable"]};
        const response={schema_version:1,grade,replay_digest:digest({
          evaluator_version:manifest.evaluator_version,benchmark_digest:manifest.benchmark_digest,
          trace_digest:saved.trace_digest,grade})};
        let stale;
        try { await finish(pool,item,response); } catch (error) { stale=error.code; }
        await finish(pool,second,response);
        await pool.end();
        console.log(JSON.stringify({record,stale,saved:saved.trace_digest===envelope.trace_digest}));
    """,
        case["work_id"],
    )
    assert check == {
        "record": {"generation": 2, "state": "queued"},
        "stale": "stale_lease",
        "saved": True,
    }
    with psycopg.connect(control_dsn) as db:
        assert db.execute(
            "SELECT status,stage FROM hl.experiments WHERE id=%s",
            (case["experiment"],),
        ).fetchone() == ("failed", "report")


def test_phase0_roles_upgrade_in_disposable_database():
    dsn = os.environ.get(
        "CONTROL_FIXTURE_ADMIN_DSN",
        "postgresql://hl_control_admin:fixture_control_admin@127.0.0.1:55432/harnesslab_control",
    )
    assert conninfo_to_dict(dsn).get("host") in {"localhost", "127.0.0.1"}
    name = f"hl_phase3_upgrade_{uuid4().hex[:16]}"
    bootstrap = Path("infra/docker/control-init.sql").read_text()
    grants = "\n".join(
        line for line in bootstrap.splitlines() if not line.startswith("CREATE ROLE")
    )
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            with psycopg.connect(make_conninfo(dsn, dbname=name), autocommit=True) as db:
                db.execute(grants.replace("harnesslab_control", name))
                assert db.execute("SELECT to_regnamespace('hl')").fetchone() == (None,)
            migrator = make_conninfo(
                dsn, dbname=name, user="hl_migrator", password="fixture_migrator"
            )
            migrate(migrator)
            migrate(migrator)
            with psycopg.connect(migrator) as db:
                assert db.execute("SELECT count(*) FROM hl_migrations.applied").fetchone() == (4,)
                assert db.execute("SELECT count(*) FROM hl.harness_channels").fetchone() == (1,)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def test_reconciles_a_missing_redis_delivery(control_dsn, work_case):
    case = work_case()
    with psycopg.connect(control_dsn, autocommit=True) as db:
        db.execute(
            """UPDATE hl.outbox SET sent_at=clock_timestamp()-interval '5 seconds'
               WHERE work_id=%s AND generation=1""",
            (case["work_id"],),
        )
        assert wait_for(db, case["experiment"]) == "completed"
        assert db.execute(
            "SELECT generation,state FROM hl.work_items WHERE id=%s", (case["work_id"],)
        ).fetchone() == (2, "done")
        assert db.execute(
            "SELECT grade->>'success' FROM hl.task_runs WHERE id=%s", (case["run_id"],)
        ).fetchone() == ("true",)


def test_real_grader_retry_reuses_durable_envelope(control_dsn, dispatcher_node, work_case):
    case = work_case()
    after = dispatcher_node(
        """
        import { controlPool } from "@harnesslab/control-db";
        import { deliver, endpoint } from "./src/delivery.ts";
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        const [work_id]=process.argv.slice(1);
        const runner=endpoint(process.env.RUNNER_URL,"/internal/v1/execute-task",
          process.env.HL_RUNNER_TOKEN);
        const evaluator=endpoint("http://127.0.0.1:1","/internal/v1/grade-task","test");
        await deliver(pool,{schema_version:1,work_id,generation:1},{
          prompts:process.env.HL_DISPATCHER_ARTIFACT_DIR,runner,evaluator,allowLive:false});
        const row=(await pool.query(
          `SELECT r.envelope->>'trace_digest' AS digest, w.generation
           FROM hl.work_items w JOIN hl.task_runs r ON w.run_id=r.id WHERE w.id=$1`,[work_id]
        )).rows[0];
        await pool.end();
        console.log(JSON.stringify(row));
    """,
        case["work_id"],
    )
    assert after["generation"] == 2 and len(after["digest"]) == 64
    with psycopg.connect(control_dsn, autocommit=True) as db:
        assert wait_for(db, case["experiment"]) == "completed"
        assert db.execute(
            "SELECT trace_digest,grade->>'success' FROM hl.task_runs WHERE id=%s", (case["run_id"],)
        ).fetchone() == (after["digest"], "true")
        assert db.execute(
            "SELECT attempts,state FROM hl.work_items WHERE id=%s", (case["work_id"],)
        ).fetchone() == (2, "done")


def test_budget_stop_occurs_before_effect_mark(control_dsn, dispatcher_node, work_case):
    case = work_case("live", cap=14999)
    outcome = dispatcher_node(
        STORE
        + """
        const row=(await pool.query("SELECT effect_started,state FROM hl.work_items WHERE id=$1",
          [work_id])).rows[0];
        await pool.end();
        console.log(JSON.stringify({reserved,row}));
    """,
        case["work_id"],
    )
    assert outcome == {"reserved": False, "row": {"effect_started": False, "state": "failed"}}
    with psycopg.connect(control_dsn) as db:
        assert db.execute(
            """SELECT spent_micros,reserved_micros,budget_exhausted,status
               FROM hl.experiments WHERE id=%s""",
            (case["experiment"],),
        ).fetchone() == (0, 0, True, "failed")
