import asyncio
from copy import deepcopy
from uuid import UUID

import psycopg
from harnesslab_opt.graph import optimize
from test_delivery import wait_for


class Snapshot:
    def __init__(self):
        self.state = None

    async def exchange(self, key):
        assert key == "optimizer_validated"
        return deepcopy(self.state)

    async def write_bounded(self, key, state):
        assert key == "optimizer_validated"
        self.state = deepcopy(state)


def test_optimizer_restart_resumes_after_validation(harness):
    parent = {k: deepcopy(harness[k]) for k in ("prompt", "workflow", "context", "limits")}
    parent["limits"] = {k: parent["limits"][k] for k in ("max_tool_calls", "max_retries_per_tool")}
    refs = [{"run_id": str(UUID(int=i, version=4)), "seq": 2} for i in (1, 2)]
    request = {
        "schema_version": 1,
        "mode": "fixture",
        "model": None,
        "parent": parent,
        "diagnosis": {
            "schema_version": 1,
            "clusters": [
                {
                    "signature": "unrecovered_fault",
                    "count": 2,
                    "evidence_refs": refs,
                }
            ],
            "counterexamples": [],
            "metrics": {
                "scheduled": 2,
                "successes": 0,
                "tool_calls": 2,
                "cost_micros": 0,
                "invalid_sql": 0,
                "sql_calls": 2,
                "faults": 2,
                "recoveries": 0,
            },
        },
    }
    checkpoint = Snapshot()
    first = asyncio.run(optimize(request, checkpoint=checkpoint))

    async def repeat(_):
        raise AssertionError("Proposer ran again after validation checkpoint")

    second = asyncio.run(optimize(request, proposer=repeat, checkpoint=checkpoint))
    assert first["dispositions"] == second["dispositions"]
    assert first["graph"]["events"][:-1] == second["graph"]["events"][:-1]


def test_worker_lost_response_reuses_checkpoint_after_reclaim(
    control_dsn,
    dispatcher_node,
    work_case,
):
    case = work_case(category="tool_failures")
    original = dispatcher_node(
        """
        import {controlPool} from "@harnesslab/control-db";
        import {claim,readRun,reserveAndMark,reclaim} from "./src/work.ts";
        import {loadPinnedTask} from "./src/artifacts.ts";
        import {postJson,endpoint} from "./src/delivery.ts";
        const pool=controlPool(process.env.CONTROL_DISPATCHER_DSN);
        const [id]=process.argv.slice(1);
        const lease=await claim(pool,{schema_version:1,work_id:id,generation:1});
        const pinned=await readRun(pool,lease.run_id);
        const {task,fault}=await loadPinnedTask(
          process.env.HL_DISPATCHER_ARTIFACT_DIR,pinned.manifest);
        if(!(await reserveAndMark(pool,lease,pinned))) throw Error("reserve failed");
        const {worker_deadline}=(await pool.query(
          "SELECT worker_deadline FROM hl.work_items WHERE id=$1",[id])).rows[0];
        const service=endpoint(process.env.RUNNER_URL,"/internal/v1/execute-task",
          process.env.HL_RUNNER_TOKEN);
        const response=await postJson(service,{schema_version:1,task,fault,harness:pinned.config,
          manifest:pinned.manifest,deadline:worker_deadline.toISOString()},
          AbortSignal.timeout(10000),lease);
        await pool.query("UPDATE hl.work_items SET lease_until=clock_timestamp()"+
          " - interval '1 second' WHERE id=$1",[id]);
        await reclaim(pool);
        await pool.end();
        console.log(JSON.stringify(response.run));
    """,
        case["work_id"],
    )
    assert len([event for event in original["events"] if event["kind"] == "fault"]) == 1
    with psycopg.connect(control_dsn, autocommit=True) as db:
        assert wait_for(db, case["experiment"]) == "completed"
        assert db.execute(
            "SELECT envelope FROM hl.task_runs WHERE id=%s", (case["run_id"],)
        ).fetchone() == (original,)
        assert db.execute(
            "SELECT generation,attempts FROM hl.work_items WHERE id=%s", (case["work_id"],)
        ).fetchone() == (2, 2)
