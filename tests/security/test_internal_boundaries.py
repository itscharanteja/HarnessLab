import subprocess
from pathlib import Path

import psycopg
from fastapi.testclient import TestClient
from harnesslab_contracts.replay import trace_digest
from harnesslab_eval.http import app as evaluator
from harnesslab_runner.http import app as runner


def test_python_internal_routes_auth_and_missing_artifacts(monkeypatch, benchmark_request):
    token = "test-only-service"
    monkeypatch.setenv("HL_DISPATCHER_TOKEN", token)
    monkeypatch.delenv("HL_SANDBOX_DEV_RUNTIME_MAP_FILE", raising=False)
    monkeypatch.delenv("HL_EVALUATOR_ARTIFACT_DIR", raising=False)
    request = benchmark_request()
    manifest = request["manifest"]
    events = [
        {
            "run_id": manifest["run_id"],
            "seq": 0,
            "elapsed_ms": 0,
            "kind": "start",
            "outcome_code": "started",
            "correlation_id": None,
            "payload": {"task_key": manifest["task_key"], "config_hash": manifest["config_hash"]},
        }
    ]
    envelope = {
        "schema_version": 1,
        "manifest": manifest,
        "answer": None,
        "events": events,
        "result": "unable",
        "trace_digest": trace_digest(events),
    }
    for app, endpoint, payload in [
        (runner, "/internal/v1/execute-task", request),
        (evaluator, "/internal/v1/grade-task", {"schema_version": 1, "run": envelope}),
    ]:
        with TestClient(app) as client:
            assert client.post(endpoint, json=payload).status_code == 401
            headers = {"authorization": f"Bearer {token}"}
            bad = client.post(endpoint, json={**payload, "unknown": 0}, headers=headers)
            assert bad.status_code == 400 and bad.json() == {"code": "invalid_request"}
            missing = client.post(endpoint, json=payload, headers=headers)
            assert missing.status_code == 503 and missing.json() == {"code": "artifact_unavailable"}


def test_online_fixture_mounts_are_role_scoped():
    commands = {
        "runner": "test -r /fixture/dev.json && test ! -e /fixture/dev/oracles.json",
        "evaluator": "test -r /fixture/validation/oracles.json"
        " && test ! -e /fixture/dev/prompts.json",
        "dispatcher": "test -r /fixture/dev/prompts.json && test ! -e /fixture/dev/oracles.json",
        "optimizer": "test ! -e /fixture",
    }
    for role, check in commands.items():
        subprocess.run(
            [
                "docker",
                "compose",
                "--file",
                "infra/docker/compose.yaml",
                "exec",
                "-T",
                role,
                "sh",
                "-c",
                f"{check} && test ! -e /fixture/holdout && test ! -e /workspace/.artifacts",
            ],
            check=True,
            timeout=15,
        )


def test_control_api_role_cannot_read_checkpoint_or_oracle_tables():
    import os

    dsn = os.environ.get(
        "CONTROL_API_DSN", "postgresql://hl_api:fixture_api@127.0.0.1:55432/harnesslab_control"
    )
    with psycopg.connect(dsn) as db:
        assert db.execute("""
            SELECT has_table_privilege('hl.graph_checkpoints','SELECT'),
                   has_table_privilege('hl.harness_channels','UPDATE'),
                   to_regclass('hl.oracles') IS NULL
        """).fetchone() == (False, False, True)
    root = Path(".artifacts/online-fixture")
    assert not any(root.glob("*/holdout"))


def test_checkpoint_requires_service_and_work_capability(dispatcher_node, work_case):
    one, two = work_case(), work_case()
    result = dispatcher_node(
        """
        import { controlPool } from "@harnesslab/control-db";
        import { claim } from "./src/work.ts";
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        const [first,second]=process.argv.slice(1);
        const one=await claim(pool,{schema_version:1,work_id:first,generation:1});
        const two=await claim(pool,{schema_version:1,work_id:second,generation:1});
        if(!one || !two) throw Error("Missing work claims");
        const body={schema_version:1,work_id:first,fence:one.fence,graph_version:"worker_v1",
          state_version:1,operation:"write",seq:0,write_key:"snapshot",state:{turn:1}};
        const checkpoint=async (data,lease=one,token=process.env.HL_WORKER_CHECKPOINT_TOKEN)=>{
          const reply=await fetch("http://127.0.0.1:4001/internal/v1/checkpoint",{
            method:"POST",headers:{"content-type":"application/json",
              authorization:`Bearer ${token}`,"x-hl-lease-token":lease.lease_token},
            body:JSON.stringify(data)
          });
          return [reply.status,await reply.json()];
        };
        const written=await checkpoint(body);
        const repeated=await checkpoint(body);
        const read=await checkpoint({...body,operation:"read",state:null});
        const conflict=await checkpoint({...body,state:{turn:2}});
        const cross=await checkpoint({...body,work_id:second,fence:two.fence});
        const wrongRole=await checkpoint(body,one,process.env.HL_OPTIMIZER_CHECKPOINT_TOKEN);
        const stale=await checkpoint({...body,fence:one.fence+1});
        const version=await checkpoint({...body,graph_version:"worker_v2"});
        const secret=await checkpoint({...body,state:{oracle:{value:1}}});
        const invalid=await checkpoint(body,one,"unknown");
        await pool.end();
        console.log(JSON.stringify({written,repeated,read,conflict,cross,wrongRole,stale,version,
          secret,invalid}));
    """,
        one["work_id"],
        two["work_id"],
    )
    assert result["written"] == result["repeated"] == result["read"]
    assert result["read"][0] == 200 and result["read"][1]["state"] == {"turn": 1}
    assert len(result["read"][1]["thread_id"]) == 64
    assert {
        key: result[key][0]
        for key in (
            "conflict",
            "cross",
            "wrongRole",
            "stale",
            "version",
            "secret",
            "invalid",
        )
    } == {
        "conflict": 409,
        "cross": 403,
        "wrongRole": 403,
        "stale": 403,
        "version": 409,
        "secret": 400,
        "invalid": 401,
    }
