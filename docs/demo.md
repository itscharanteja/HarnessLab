# Two-minute fixture demo

Run `make dev` and open [HarnessLab](http://localhost:3000). Launch from that browser tab so its signed session can read the new experiment. For a terminal check, `make demo-fixture` starts a separate anonymous session, waits for the comparison and saves the local JSON report. Its comparison URL identifies that session's experiment. Start from the dashboard when presenting in a browser.

| Time | Show                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Select **Run fixture experiment**. Point out **Fixture model**, **Development only**, and the pinned baseline hash. The run uses scripted model turns and real read-only MCP calls to synthetic PostgreSQL.                                         |
| 0:25 | Open **Diagnosis and proposals** as soon as the diagnosis stage completes. Follow a **Failure event** from the schema-discovery cluster to the baseline's SQL attempt. Open **Ordered graph events** to connect the executed path to its trace.     |
| 0:55 | Return to the experiment and open the candidate hash. Show its immutable parent and changed YAML path. Return to **Open comparison**, then select the same task and repeat in both arms. Expand a tool result to inspect the evidence and outcome.  |
| 1:30 | Show the candidate's measured counts and the **Promotion gate**. This fixture remains ineligible. The comparison can also be incomplete or inconclusive, and the report retains those results.                                                      |
| 1:50 | Return to **Experiment history** and show the stored run. If an authorized, published live comparison is available, open it separately and identify its task count, pinned model snapshot, run date and report digest before describing the result. |

The dashboard reports what the stored runs show. The fixture demonstrates the trace-to-config workflow and provides no live performance estimate. Production activation and rollback require operator review.
