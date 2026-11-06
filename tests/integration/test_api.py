import os
import time
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from scripts.db_migrate import migrate

OPERATOR = {"authorization": "Bearer fixture-local-operator-token-00000001"}
MIGRATOR = "postgresql://hl_migrator:fixture_migrator@127.0.0.1:55432/harnesslab_control"


def mutation(client, path, body, *, key=None):
    return client.post(path, json=body, headers={"idempotency-key": key or str(uuid4())})


@pytest.fixture
def clients():
    port = os.environ.get("WEB_PORT", "3000")
    headers = {"origin": f"http://localhost:{port}"}
    base = f"http://127.0.0.1:{port}/api/v1"
    with (
        httpx.Client(base_url=base, headers=headers, timeout=12) as owner,
        httpx.Client(base_url=base, headers=headers, timeout=12) as stranger,
        httpx.Client(base_url=base, headers={**headers, **OPERATOR}, timeout=12) as operator,
    ):
        yield owner, stranger, operator


@pytest.fixture
def public_runs():
    ids = []
    yield ids
    if ids:
        dsn = os.environ.get("CONTROL_MIGRATOR_DSN", MIGRATOR)
        assert conninfo_to_dict(dsn).get("host") in {"localhost", "127.0.0.1"}
        with psycopg.connect(dsn) as db:
            # Release only the quota entries created by this integration test.
            db.execute(
                "UPDATE hl.public_experiments SET started_at=now()-interval '2 hours' "
                "WHERE experiment_id=ANY(%s::uuid[])",
                (ids,),
            )
            db.execute(
                "DELETE FROM hl.published_experiments WHERE experiment_id=ANY(%s::uuid[])",
                (ids,),
            )


def wait_for(client, experiment, wanted, seconds=110):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = client.get(f"experiments/{experiment}")
        result.raise_for_status()
        record = result.json()["experiment"]
        if record["status"] == wanted:
            return
        assert record["status"] not in {"completed", "failed", "cancelled"}, record
        time.sleep(2)
    pytest.fail(f"Fixture experiment did not reach {wanted}")


@pytest.mark.skipif(os.environ.get("HL_API_CHECK") != "1", reason="run make api-check")
def test_public_fixture_normal_proxy_path_scoped_graphs_and_operator_review(
    clients,
    public_runs,
    control_dsn,
):
    owner, stranger, operator = clients
    assert owner.get("experiments").status_code == 200
    signed_cookie = owner.cookies.get("hl_session")
    assert signed_cookie
    key = str(uuid4())
    request = {"scope": "demo_fixture"}
    accepted = mutation(owner, "experiments", request, key=key)
    assert accepted.status_code == 202, accepted.text
    experiment = accepted.json()["id"]
    public_runs.append(experiment)
    repeat = mutation(owner, "experiments", request, key=key)
    assert repeat.status_code == 202 and repeat.json()["id"] == experiment
    assert mutation(owner, "experiments", request).status_code == 429
    assert stranger.get(f"experiments/{experiment}?graph=1").status_code == 404
    assert mutation(stranger, f"experiments/{experiment}/cancel", {}).status_code == 404
    raw_cookie = signed_cookie[:-1] + ("A" if signed_cookie[-1] != "A" else "B")
    spoof = stranger.get(
        f"experiments/{experiment}", headers={"cookie": f"hl_session={raw_cookie}"}
    )
    assert spoof.status_code == 404
    assert mutation(operator, f"experiments/{experiment}/publish", {}).status_code == 409
    wait_for(owner, experiment, "completed")
    detail = owner.get(f"experiments/{experiment}").json()
    assert "optimizer_graph" not in detail
    assert "active_revision" not in detail
    graph = owner.get(f"experiments/{experiment}?graph=1").json()["optimizer_graph"]
    assert graph["graph_kind"] == "optimizer"
    assert graph["events"]
    runs = owner.get(f"experiments/{experiment}/runs?limit=1").json()
    next_page = owner.get(f"experiments/{experiment}/runs?cursor={runs['next_cursor']}").json()
    run_id = runs["items"][0]["run_id"]
    assert run_id not in {row["run_id"] for row in next_page["items"]}
    assert stranger.get(f"runs/{run_id}/trace?graph=1").status_code == 404
    trace = owner.get(f"runs/{run_id}/trace?graph=1").json()
    assert trace["worker_graph"]["graph_kind"] == "worker"
    assert trace["items"]
    assert "checkpoint" not in trace and "envelope" not in trace
    assert all(
        event["payload"]["request_id"] is None
        for event in trace["items"]
        if event["kind"] == "model_usage"
    )
    report = owner.get(f"experiments/{experiment}/comparisons").json()["items"][0]
    review = {
        "candidate_hash": report["candidate_hash"],
        "report_digest": report["report_digest"],
        "expected_revision": 1,
        "reason": "Fixture review",
    }
    assert mutation(owner, f"experiments/{experiment}/promote", review).status_code == 401
    assert mutation(operator, f"experiments/{experiment}/promote", review).status_code == 403
    rejection = mutation(operator, f"experiments/{experiment}/reject", review)
    assert rejection.status_code == 200, rejection.text
    assert operator.get(f"experiments/{experiment}").json()["decisions"][0]["kind"] == "reject"
    publish_key = str(uuid4())
    for _ in range(2):
        assert mutation(
            operator, f"experiments/{experiment}/publish", {}, key=publish_key
        ).json() == {
            "id": experiment,
            "published": True,
        }
    assert stranger.get(f"experiments/{experiment}?graph=1").status_code == 200
    assert stranger.get(f"runs/{run_id}/trace?graph=1").status_code == 200
    assert owner.get(f"harnesses/{report['candidate_hash']}").json()["diff"]
    with psycopg.connect(control_dsn) as db:
        assert db.execute(
            "SELECT mode,spent_micros FROM hl.experiments WHERE id=%s", (experiment,)
        ).fetchone() == ("fixture", 0)


@pytest.mark.skipif(os.environ.get("HL_API_CHECK") != "1", reason="run make api-check")
def test_public_deadline_and_idempotent_cancel(clients, public_runs):
    owner, _, _ = clients
    request = {"scope": "demo_fixture"}
    accepted = mutation(owner, "experiments", request)
    assert accepted.status_code == 202, accepted.text
    experiment = accepted.json()["id"]
    public_runs.append(experiment)
    dsn = os.environ.get("CONTROL_MIGRATOR_DSN", MIGRATOR)
    assert conninfo_to_dict(dsn).get("host") in {"localhost", "127.0.0.1"}
    deadline = time.monotonic() + 30
    with psycopg.connect(dsn, autocommit=True) as db:
        while time.monotonic() < deadline:
            (remaining,) = db.execute(
                "SELECT extract(epoch FROM deadline-clock_timestamp()) "
                "FROM hl.public_experiments WHERE experiment_id=%s",
                (experiment,),
            ).fetchone()
            if remaining is not None:
                assert 100 < remaining <= 120
                break
            time.sleep(0.25)
        else:
            pytest.fail("Dispatcher never pinned the public deadline")
        db.execute(
            "UPDATE hl.public_experiments SET deadline=clock_timestamp() WHERE experiment_id=%s",
            (experiment,),
        )
    wait_for(owner, experiment, "cancelled", seconds=10)
    key = str(uuid4())
    for _ in range(2):
        response = mutation(owner, f"experiments/{experiment}/cancel", {}, key=key)
        assert response.status_code == 202
        assert response.json()["status"] == "cancelled"
    response = mutation(owner, f"experiments/{uuid4()}/cancel", {}, key=key)
    assert response.status_code == 409 and response.json()["code"] == "idempotency_conflict"


@pytest.fixture
def quota_db():
    admin_dsn = os.environ.get(
        "CONTROL_FIXTURE_ADMIN_DSN",
        "postgresql://hl_control_admin:fixture_control_admin@127.0.0.1:55432/harnesslab_control",
    )
    assert conninfo_to_dict(admin_dsn).get("host") in {"localhost", "127.0.0.1"}
    name = f"hl_quota_{uuid4().hex[:16]}"
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
            migrate(migrator)
            yield name, migrator
        finally:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def test_dispatcher_public_quotas_are_atomic_and_rolling(quota_db, dispatcher_node):
    name, migrator = quota_db
    command = """
      import { controlPool } from "@harnesslab/control-db";
      import { submitTrial } from "./src/trials.ts";
      const [name,action]=process.argv.slice(1);
      const url=new URL(process.env.CONTROL_DISPATCHER_DSN); url.pathname="/"+name;
      const pool=controlPool(url.toString());
      const principal=(i)=>"public:00000000-0000-4000-8000-"+String(i).padStart(12,"0");
      const submit=(key,i)=>submitTrial(pool,process.env.HL_DISPATCHER_ARTIFACT_DIR,key,
        undefined,principal(i)).catch(error=>error.code);
      let output;
      if(action==="concurrent"){
        const same=await Promise.all([submit("first",1),submit("first",1)]);
        const other=await Promise.all([submit("second",1),submit("third",2),submit("fourth",3)]);
        output={same,other};
      } else {
        output=await submit("rolling",42);
      }
      await pool.end();
      console.log(JSON.stringify(output));
    """
    result = dispatcher_node(command, name, "concurrent")
    assert result["same"][0] == result["same"][1] != "public_quota"
    assert result["other"][0] == "public_quota"
    assert result["other"][1:].count("public_quota") == 1
    with psycopg.connect(migrator) as db:
        assert db.execute("SELECT count(*) FROM hl.public_experiments").fetchone() == (2,)
        db.execute("UPDATE hl.experiments SET status='completed'")
        template = db.execute(
            "SELECT baseline_id,channel,channel_revision,manifest FROM hl.experiments LIMIT 1"
        ).fetchone()
        for i in range(8):
            principal = f"public:{uuid4()}"
            db.execute(
                """WITH e AS (INSERT INTO hl.experiments
                (baseline_id,channel,channel_revision,manifest,principal,idempotency_key,
                 request_hash,mode,scope,max_spend_micros,status)
                VALUES(%s,%s,%s,%s,%s,%s,%s,'fixture','demo_fixture',0,'completed') RETURNING id)
                INSERT INTO hl.public_experiments(experiment_id,principal) SELECT id,%s FROM e""",
                (
                    *template[:3],
                    psycopg.types.json.Jsonb(template[3]),
                    principal,
                    str(i),
                    "0" * 64,
                    principal,
                ),
            )
    assert dispatcher_node(command, name, "rolling") == "public_quota"
    with psycopg.connect(migrator) as db:
        db.execute(
            "UPDATE hl.public_experiments SET started_at=now()-interval '61 minutes' "
            "WHERE experiment_id=(SELECT experiment_id FROM hl.public_experiments LIMIT 1)"
        )
    assert dispatcher_node(command, name, "rolling") != "public_quota"


def test_published_live_experiment_hides_validation_runs_and_graphs(quota_db):
    import json
    import subprocess

    name, migrator = quota_db
    experiment, run = uuid4(), uuid4()
    task = "synthetic-business-v1/validation/v01/efficiency/001"
    with psycopg.connect(migrator) as db:
        baseline, revision = db.execute(
            "SELECT active_version_id,revision FROM hl.harness_channels WHERE channel='fixture'"
        ).fetchone()
        db.execute(
            """INSERT INTO hl.experiments
            (id,baseline_id,channel,channel_revision,principal,idempotency_key,request_hash,
             mode,scope,max_spend_micros,manifest,status,stage)
            VALUES(%s,%s,'fixture',%s,'operator:test','published',%s,
                'live','full_live',1,'{"schema_version":1}','completed','report')""",
            (experiment, baseline, revision, "0" * 64),
        )
        db.execute(
            """INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
            VALUES(%s,%s,'baseline',0,'scheduled')""",
            (experiment, baseline),
        )
        db.execute(
            """INSERT INTO hl.benchmark_tasks(benchmark_digest,task_key,split,category,
            dataset_digest,variant_id,input_hash)
            VALUES(%s,%s,'validation','efficiency',%s,'v01',%s)
            """,
            ("1" * 64, task, "2" * 64, "3" * 64),
        )
        db.execute(
            """INSERT INTO hl.task_runs(id,experiment_id,harness_id,benchmark_digest,task_key,
            stage,repeat,manifest) VALUES(%s,%s,%s,%s,%s,'validate',1,'{"schema_version":1}')""",
            (run, experiment, baseline, "1" * 64, task),
        )
        work = db.execute(
            """INSERT INTO hl.work_items(experiment_id,work_key,kind,run_id,state)
            VALUES(%s,'fake-validate','execute_task',%s,'done') RETURNING id""",
            (experiment, run),
        ).fetchone()[0]
        db.execute(
            """INSERT INTO hl.graph_projections(work_id,run_id,projection)
            VALUES(%s,%s,'{"schema_version":1,"graph_kind":"worker",
                            "graph_version":"worker_v1","events":[]}')""",
            (work, run),
        )
        db.execute("INSERT INTO hl.published_experiments VALUES(%s,'operator:test')", (experiment,))
    script = """
      import Fastify from "fastify";
      import { controlPool } from "@harnesslab/control-db";
      import { registerRoutes,sendError } from "./src/routes.ts";
      const [db,experiment,run]=process.argv.slice(1);
      const url=new URL(process.env.CONTROL_API_DSN); url.pathname="/"+db;
      const pool=controlPool(url.toString());
      const app=Fastify();
      app.setErrorHandler((e,r,p)=>sendError(p,r,e.status??503,e.code??"service_unavailable"));
      await registerRoutes(app,pool);
      const read=(path,operator=false)=>app.inject({method:"GET",url:"/v1/"+path,
        headers:{"x-hl-proxy-token":process.env.HL_PROXY_TOKEN,
          ...(operator?{authorization:"Bearer "+process.env.HL_FIXTURE_OPERATOR_TOKEN}:{})}});
      const [detail,runs,publicTrace,operatorTrace]=await Promise.all([
        read("experiments/"+experiment),read("experiments/"+experiment+"/runs"),
        read("runs/"+run+"/trace?graph=1"),read("runs/"+run+"/trace?graph=1",true)
      ]);
      console.log(JSON.stringify({
        detail:detail.statusCode, runs:runs.json(), publicTrace:publicTrace.statusCode,
        operatorTrace:operatorTrace.json()
      }));
      await app.close(); await pool.end();
    """
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--file",
            "infra/docker/compose.yaml",
            "exec",
            "-T",
            "-w",
            "/workspace/apps/api",
            "api",
            "node",
            "--input-type=module",
            "-e",
            script,
            name,
            str(experiment),
            str(run),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=25,
    )
    output = json.loads(result.stdout)
    assert output["detail"] == 200
    assert output["runs"] == {"items": [], "next_cursor": None}
    assert output["publicTrace"] == 404
    assert output["operatorTrace"]["worker_graph"]["graph_kind"] == "worker"
    assert output["operatorTrace"]["run"]["task_key"] == task
