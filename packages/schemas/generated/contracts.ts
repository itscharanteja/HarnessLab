// Generated from packages/schemas/contracts/v1.json.

export type Digest = string;
export type Uuid = string;
export type Identifier = string;
export type DecimalString = string;
export type UtcTimestamp = string;
export type Stage = "diagnose" | "propose" | "screen" | "validate" | "report";
export type TaskSplit = "dev" | "validation" | "holdout";
export type Category =
  | "schema_discovery"
  | "multi_step_analytics"
  | "data_inconsistencies"
  | "tool_failures"
  | "ambiguous_requests"
  | "efficiency";
export type Mode = "fixture" | "live";
export type ExperimentScope = "demo_fixture" | "full_live";
export type ExperimentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type OutcomeCode = string;
export type TaskKey = string;
export type Unit = string;
export type EvidenceRef = CellRef | CalculationRef;
export type Scalar = string | number | boolean | null;
export type FindingValue = Scalar | Scalar[];
export type WorkerAnswer =
  | {
      kind: "answer";
      /**
       * @minItems 1
       * @maxItems 40
       */
      findings: Finding[];
    }
  | {
      kind: "clarify";
      /**
       * @minItems 1
       * @maxItems 10
       */
      missing_fields: Identifier[];
      question: string;
    }
  | {
      kind: "unable";
      reason: OutcomeCode;
    };
export type ToolName =
  | "list_tables"
  | "describe_schema"
  | "execute_readonly_sql"
  | "get_business_definition"
  | "validate_calculation"
  | "inspect_query_error";
export type ToolCall =
  | ListTablesCall
  | DescribeSchemaCall
  | ExecuteReadonlySqlCall
  | GetBusinessDefinitionCall
  | ValidateCalculationCall
  | InspectQueryErrorCall;
export type ToolResult =
  | ListTablesSuccess
  | DescribeSchemaSuccess
  | ExecuteReadonlySqlSuccess
  | GetBusinessDefinitionSuccess
  | ValidateCalculationSuccess
  | InspectQueryErrorSuccess
  | ToolError;
export type PatchOperation =
  | {
      op: "replace";
      path: "/prompt/task_guidance";
      value: string;
    }
  | {
      op: "replace";
      path: "/workflow/schema_inspection";
      value: "on_error" | "before_first_sql";
    }
  | {
      op: "replace";
      path: "/workflow/verify_numeric_answers";
      value: boolean;
    }
  | {
      op: "replace";
      path: "/workflow/retry_policy";
      value: "none" | "error_aware";
    }
  | {
      op: "replace";
      path: "/context/recent_tool_results";
      value: number;
    }
  | {
      op: "replace";
      path: "/limits/max_tool_calls";
      value: number;
    }
  | {
      op: "replace";
      path: "/limits/max_retries_per_tool";
      value: number;
    };
export type TraceEvent =
  | {
      kind: "start";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: {
        task_key: TaskKey;
        config_hash: Digest;
      };
    }
  | {
      kind: "model_usage";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: ModelUsage;
    }
  | {
      kind: "policy_decision";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: {
        reason: OutcomeCode;
        safety_violation: boolean;
      };
    }
  | {
      kind: "tool_request";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: {
        origin: "model" | "harness";
        call: ToolCall;
      };
    }
  | {
      kind: "tool_result";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: ToolResult;
    }
  | {
      kind: "fault";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: FaultFixture;
    }
  | {
      kind: "recovery";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: {
        tool: ToolName;
        error_id: Identifier;
      };
    }
  | {
      kind: "final_output";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: WorkerAnswer;
    }
  | {
      kind: "grade";
      run_id: Uuid;
      seq: number;
      elapsed_ms: number;
      outcome_code: OutcomeCode;
      correlation_id: string | null;
      payload: Grade;
    };
export type ExperimentSubmit =
  | {
      scope: "demo_fixture";
    }
  | {
      scope: "full_live";
      max_spend_microusd?: number;
    };

export interface ContractCatalog {
  Digest: Digest;
  Uuid: Uuid;
  Identifier: Identifier;
  DecimalString: DecimalString;
  UtcTimestamp: UtcTimestamp;
  Stage: Stage;
  TaskSplit: TaskSplit;
  Category: Category;
  Mode: Mode;
  ExperimentScope: ExperimentScope;
  ExperimentStatus: ExperimentStatus;
  OutcomeCode: OutcomeCode;
  TaskKey: TaskKey;
  Unit: Unit;
  EventRef: EventRef;
  CellRef: CellRef;
  CalculationRef: CalculationRef;
  EvidenceRef: EvidenceRef;
  CalculationOperand: CalculationOperand;
  Scalar: Scalar;
  FindingValue: FindingValue;
  OutputKey: OutputKey;
  TaskInput: TaskInput;
  Finding: Finding;
  WorkerAnswer: WorkerAnswer;
  ToolName: ToolName;
  ListTablesArgs: ListTablesArgs;
  ListTablesData: ListTablesData;
  ListTablesCall: ListTablesCall;
  ListTablesSuccess: ListTablesSuccess;
  DescribeSchemaArgs: DescribeSchemaArgs;
  DescribeSchemaData: DescribeSchemaData;
  DescribeSchemaCall: DescribeSchemaCall;
  DescribeSchemaSuccess: DescribeSchemaSuccess;
  ExecuteReadonlySqlArgs: ExecuteReadonlySqlArgs;
  ExecuteReadonlySqlData: ExecuteReadonlySqlData;
  ExecuteReadonlySqlCall: ExecuteReadonlySqlCall;
  ExecuteReadonlySqlSuccess: ExecuteReadonlySqlSuccess;
  GetBusinessDefinitionArgs: GetBusinessDefinitionArgs;
  GetBusinessDefinitionData: GetBusinessDefinitionData;
  GetBusinessDefinitionCall: GetBusinessDefinitionCall;
  GetBusinessDefinitionSuccess: GetBusinessDefinitionSuccess;
  ValidateCalculationArgs: ValidateCalculationArgs;
  ValidateCalculationData: ValidateCalculationData;
  ValidateCalculationCall: ValidateCalculationCall;
  ValidateCalculationSuccess: ValidateCalculationSuccess;
  InspectQueryErrorArgs: InspectQueryErrorArgs;
  InspectQueryErrorData: InspectQueryErrorData;
  InspectQueryErrorCall: InspectQueryErrorCall;
  InspectQueryErrorSuccess: InspectQueryErrorSuccess;
  ToolCall: ToolCall;
  ToolError: ToolError;
  ToolResult: ToolResult;
  WorkerAction: WorkerAction;
  HarnessConfig: HarnessConfig;
  PatchOperation: PatchOperation;
  Proposal: Proposal;
  ProposalBatch: ProposalBatch;
  ModelUsage: ModelUsage;
  Grade: Grade;
  FaultFixture: FaultFixture;
  TraceEvent: TraceEvent;
  ModelSettings: ModelSettings;
  RunManifest: RunManifest;
  RunEnvelope: RunEnvelope;
  ArmMetrics: ArmMetrics;
  PairedMetrics: PairedMetrics;
  Interval: Interval;
  GateResult: GateResult;
  ComparisonRun: ComparisonRun;
  ComparisonCell: ComparisonCell;
  CompareRequest: CompareRequest;
  EvaluationReport: EvaluationReport;
  QueueReference: QueueReference;
  HealthResponse: HealthResponse;
  HttpError: HttpError;
  ExperimentSubmit: ExperimentSubmit;
  ExperimentAccepted: ExperimentAccepted;
  DecisionRequest: DecisionRequest;
  RollbackRequest: RollbackRequest;
  PageQuery: PageQuery;
  ExecuteTaskRequest: ExecuteTaskRequest;
  GradeTaskRequest: GradeTaskRequest;
  GradeTaskResponse: GradeTaskResponse;
  ExperimentSummary: ExperimentSummary;
  TaskRunSummary: TaskRunSummary;
  HarnessSummary: HarnessSummary;
  GraphEvent: GraphEvent;
  GraphProjection: GraphProjection;
  ExecuteTaskResponse: ExecuteTaskResponse;
  CheckpointRequest: CheckpointRequest;
  CheckpointResponse: CheckpointResponse;
  DiagnosisEvent: DiagnosisEvent;
  DiagnosisRun: DiagnosisRun;
  AnalyzeDevRequest: AnalyzeDevRequest;
  FailureCluster: FailureCluster;
  DevDiagnosis: DevDiagnosis;
  MutableHarness: MutableHarness;
  OptimizeRequest: OptimizeRequest;
  ProposalDisposition: ProposalDisposition;
  OptimizeResponse: OptimizeResponse;
}
export interface EventRef {
  run_id: Uuid;
  seq: number;
}
export interface CellRef {
  kind: "cell";
  query_id: Identifier;
  row: number;
  column: string;
}
export interface CalculationRef {
  kind: "calculation";
  calculation_id: Identifier;
}
export interface CalculationOperand {
  source: EvidenceRef;
  unit: Unit;
}
export interface OutputKey {
  key: Identifier;
  unit: Unit;
  value_type: "integer" | "decimal" | "string" | "boolean" | "string_set" | "integer_set";
}
export interface TaskInput {
  schema_version: 1;
  task_key: TaskKey;
  split: TaskSplit;
  variant_id: string;
  category: Category;
  prompt: string;
  /**
   * @minItems 0
   * @maxItems 40
   */
  output_keys: OutputKey[];
  /**
   * @minItems 0
   * @maxItems 10
   */
  allowed_clarification_fields: Identifier[];
}
export interface Finding {
  key: Identifier;
  value: FindingValue;
  unit: Unit;
  /**
   * @minItems 1
   * @maxItems 20
   */
  evidence: EvidenceRef[];
}
export interface ListTablesArgs {}
export interface ListTablesData {
  /**
   * @minItems 0
   * @maxItems 64
   */
  tables: Identifier[];
}
export interface ListTablesCall {
  kind: "tool";
  name: "list_tables";
  arguments: ListTablesArgs;
}
export interface ListTablesSuccess {
  status: "ok";
  name: "list_tables";
  data: ListTablesData;
}
export interface DescribeSchemaArgs {
  /**
   * @minItems 1
   * @maxItems 6
   */
  tables: Identifier[];
}
export interface DescribeSchemaData {
  /**
   * @minItems 1
   * @maxItems 6
   */
  tables: {
    name: Identifier;
    /**
     * @minItems 1
     * @maxItems 64
     */
    columns: {
      name: Identifier;
      type: string;
      nullable: boolean;
    }[];
    /**
     * @minItems 0
     * @maxItems 12
     */
    primary_key: Identifier[];
    /**
     * @minItems 0
     * @maxItems 32
     */
    foreign_keys: {
      /**
       * @minItems 1
       * @maxItems 12
       */
      columns: Identifier[];
      table: Identifier;
      /**
       * @minItems 1
       * @maxItems 12
       */
      references: Identifier[];
    }[];
  }[];
}
export interface DescribeSchemaCall {
  kind: "tool";
  name: "describe_schema";
  arguments: DescribeSchemaArgs;
}
export interface DescribeSchemaSuccess {
  status: "ok";
  name: "describe_schema";
  data: DescribeSchemaData;
}
export interface ExecuteReadonlySqlArgs {
  sql: string;
}
export interface ExecuteReadonlySqlData {
  query_id: Identifier;
  /**
   * @minItems 1
   * @maxItems 200
   */
  columns: {
    name: string;
    type: "integer" | "decimal" | "boolean" | "string" | "timestamp" | "date";
  }[];
  /**
   * @minItems 0
   * @maxItems 200
   */
  rows: Scalar[][];
  payload_hash: Digest;
}
export interface ExecuteReadonlySqlCall {
  kind: "tool";
  name: "execute_readonly_sql";
  arguments: ExecuteReadonlySqlArgs;
}
export interface ExecuteReadonlySqlSuccess {
  status: "ok";
  name: "execute_readonly_sql";
  data: ExecuteReadonlySqlData;
}
export interface GetBusinessDefinitionArgs {
  metric_id: Identifier;
}
export interface GetBusinessDefinitionData {
  metric_id: Identifier;
  catalog_version: string;
  definition: string;
  unit: Unit;
}
export interface GetBusinessDefinitionCall {
  kind: "tool";
  name: "get_business_definition";
  arguments: GetBusinessDefinitionArgs;
}
export interface GetBusinessDefinitionSuccess {
  status: "ok";
  name: "get_business_definition";
  data: GetBusinessDefinitionData;
}
export interface ValidateCalculationArgs {
  operation: "identity" | "sum" | "difference" | "product" | "ratio";
  /**
   * @minItems 1
   * @maxItems 32
   */
  operands: CalculationOperand[];
}
export interface ValidateCalculationData {
  calculation_id: Identifier;
  value: DecimalString;
  unit: Unit;
  /**
   * @minItems 1
   * @maxItems 32
   */
  sources: CalculationOperand[];
}
export interface ValidateCalculationCall {
  kind: "tool";
  name: "validate_calculation";
  arguments: ValidateCalculationArgs;
}
export interface ValidateCalculationSuccess {
  status: "ok";
  name: "validate_calculation";
  data: ValidateCalculationData;
}
export interface InspectQueryErrorArgs {
  error_id: Identifier;
}
export interface InspectQueryErrorData {
  error_id: Identifier;
  error_class: OutcomeCode;
  retryable: boolean;
  hint: string;
}
export interface InspectQueryErrorCall {
  kind: "tool";
  name: "inspect_query_error";
  arguments: InspectQueryErrorArgs;
}
export interface InspectQueryErrorSuccess {
  status: "ok";
  name: "inspect_query_error";
  data: InspectQueryErrorData;
}
export interface ToolError {
  status: "error";
  name: ToolName;
  error_id: Identifier;
  code: OutcomeCode;
}
export interface WorkerAction {
  action:
    | ListTablesCall
    | DescribeSchemaCall
    | ExecuteReadonlySqlCall
    | GetBusinessDefinitionCall
    | ValidateCalculationCall
    | InspectQueryErrorCall
    | {
        kind: "finish";
        answer: WorkerAnswer;
      };
}
export interface HarnessConfig {
  schema_version: 1;
  model_profile: "dataops-fixed-v1";
  prompt: {
    task_guidance: string;
  };
  workflow: {
    schema_inspection: "on_error" | "before_first_sql";
    verify_numeric_answers: boolean;
    retry_policy: "none" | "error_aware";
  };
  context: {
    recent_tool_results: number;
  };
  limits: {
    max_tool_calls: number;
    max_retries_per_tool: number;
    max_model_turns: 10;
    max_input_tokens: 12000;
    max_output_tokens: 3000;
  };
  output_contract: "dataops-answer-v1";
  tool_registry: "dataops-mcp-v1";
  safety_profile: "readonly-synthetic-v1";
}
export interface Proposal {
  /**
   * @minItems 1
   * @maxItems 2
   */
  patch: PatchOperation[];
  expected_metric:
    "success_rate" | "invalid_sql_rate" | "tool_calls_per_success" | "recovery_rate" | "cost_per_success";
  direction: "increase" | "decrease";
  rationale: string;
  /**
   * @minItems 1
   * @maxItems 15
   */
  evidence_refs: EventRef[];
}
export interface ProposalBatch {
  /**
   * @minItems 0
   * @maxItems 3
   */
  proposals: Proposal[];
}
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  request_id: string | null;
}
export interface Grade {
  schema_version: 1;
  success: boolean;
  /**
   * @minItems 0
   * @maxItems 60
   */
  reasons: OutcomeCode[];
}
export interface FaultFixture {
  tool: "execute_readonly_sql";
  kind: "timeout" | "malformed_result" | "transient";
  match: "first_eligible_sql";
}
export interface ModelSettings {
  snapshot: string;
  timeout_ms: number;
  reasoning_effort: ("none" | "minimal" | "low" | "medium" | "high" | "xhigh") | null;
  temperature: DecimalString | null;
  top_p: DecimalString | null;
}
export interface RunManifest {
  schema_version: 1;
  run_id: Uuid;
  mode: Mode;
  stage: Stage;
  task_key: TaskKey;
  repeat: number;
  task_input_hash: Digest;
  config_hash: Digest;
  dataset_digest: Digest;
  benchmark_digest: Digest;
  software_revision: string;
  evaluator_version: string;
  safety_profile: "readonly-synthetic-v1";
  worker: ModelSettings;
  worker_profile_digest: Digest;
  price_profile_digest: Digest;
  schedule_seed: number;
}
export interface RunEnvelope {
  schema_version: 1;
  manifest: RunManifest;
  answer: WorkerAnswer | null;
  /**
   * @minItems 1
   * @maxItems 150
   */
  events: TraceEvent[];
  result: "answered" | "clarified" | "unable" | "unsafe" | "budget_exhausted" | "infrastructure_error";
  trace_digest: Digest;
}
export interface ArmMetrics {
  scheduled: number;
  attempted: number;
  successes: number;
  success_rate: DecimalString | null;
  tool_calls: number;
  tool_calls_per_success: DecimalString | null;
  mean_calls_successful: DecimalString | null;
  worker_cost_microusd: number;
  worker_cost_per_success: DecimalString | null;
  invalid_sql_attempts: number;
  sql_attempts: number;
  invalid_sql_rate: DecimalString | null;
  recovered_faults: number;
  scheduled_recoverable_faults: number;
  recovery_rate: DecimalString | null;
  p50_ms: number | null;
  p95_ms: number | null;
  safety_violations: number;
}
export interface PairedMetrics {
  wins: number;
  losses: number;
  ties: number;
  success_delta: DecimalString | null;
  cost_reduction: DecimalString | null;
}
export interface Interval {
  low: DecimalString;
  high: DecimalString;
}
export interface GateResult {
  gate: Identifier;
  status: "passed" | "failed" | "unavailable";
  reason: OutcomeCode;
}
export interface ComparisonRun {
  run_id: Uuid;
  trace_digest: Digest | null;
  complete: boolean;
  success: boolean;
  latency_ms: number;
  tool_calls: number;
  worker_cost_microusd: number;
  invalid_sql_attempts: number;
  sql_attempts: number;
  recovered: boolean;
  safety_violations: number;
}
export interface ComparisonCell {
  task_key: TaskKey;
  category: Category;
  repeat: number;
  recoverable_fault: boolean;
  baseline: ComparisonRun | null;
  candidate: ComparisonRun | null;
}
export interface CompareRequest {
  schema_version: 1;
  experiment_id: Uuid;
  baseline_hash: Digest;
  candidate_hash: Digest;
  scope: "dev_fixture" | "dev_screen" | "validation" | "holdout";
  mode: Mode;
  manifest_digest: Digest;
  roster_digest: Digest;
  provenance_valid: boolean;
  candidate_dev_safe: boolean;
  seed: number;
  /**
   * @maxItems 90
   */
  cells: ComparisonCell[];
}
export interface EvaluationReport {
  schema_version: 1;
  experiment_id: Uuid;
  baseline_hash: Digest;
  candidate_hash: Digest;
  scope: "dev_fixture" | "dev_screen" | "validation" | "holdout";
  mode: Mode;
  policy_version: string;
  manifest_digest: Digest;
  roster_digest: Digest;
  evidence_digest: Digest;
  report_digest: Digest;
  complete: boolean;
  winner: boolean;
  baseline: ArmMetrics;
  candidate: ArmMetrics;
  paired: PairedMetrics;
  /**
   * @minItems 0
   * @maxItems 6
   */
  categories: {
    category: Category;
    baseline: ArmMetrics;
    candidate: ArmMetrics;
    paired: PairedMetrics;
  }[];
  uncertainty: {
    seed: number;
    resamples: 10000;
    success_delta_95: Interval | null;
    cost_reduction_95: Interval | null;
    success_delta_lower: DecimalString | null;
    cost_reduction_lower: DecimalString | null;
    /**
     * @minItems 0
     * @maxItems 12
     */
    leave_one_variant_out: {
      variant_id: string;
      paired: PairedMetrics;
    }[];
  } | null;
  /**
   * @minItems 0
   * @maxItems 12
   */
  gates: GateResult[];
}
export interface QueueReference {
  schema_version: 1;
  work_id: Uuid;
  generation: number;
}
export interface HealthResponse {
  status: "ok" | "unavailable";
}
export interface HttpError {
  code: OutcomeCode;
  message: string;
  request_id: string;
}
export interface ExperimentAccepted {
  id: Uuid;
  status: ExperimentStatus;
}
export interface DecisionRequest {
  candidate_hash: Digest;
  report_digest: Digest;
  expected_revision: number;
  reason: string;
}
export interface RollbackRequest {
  expected_revision: number;
  reason: string;
}
export interface PageQuery {
  cursor?: string;
  limit?: number;
}
export interface ExecuteTaskRequest {
  schema_version: 1;
  task: TaskInput;
  harness: HarnessConfig;
  manifest: RunManifest;
  fault: FaultFixture | null;
  deadline: UtcTimestamp;
}
export interface GradeTaskRequest {
  schema_version: 1;
  run: RunEnvelope;
}
export interface GradeTaskResponse {
  schema_version: 1;
  grade: Grade;
  replay_digest: Digest;
}
export interface ExperimentSummary {
  id: Uuid;
  status: ExperimentStatus;
  stage: Stage;
  scope: ExperimentScope;
  mode: Mode;
  baseline_hash: Digest;
  created_at: UtcTimestamp;
  completed_at: UtcTimestamp | null;
  scheduled_runs: number;
  terminal_runs: number;
}
export interface TaskRunSummary {
  run_id: Uuid;
  task_key: TaskKey;
  stage: Stage;
  repeat: number;
  harness_hash: Digest;
  result: OutcomeCode;
  grade: Grade | null;
}
export interface HarnessSummary {
  hash: Digest;
  parent_hash: Digest | null;
  config: HarnessConfig;
  active: boolean;
}
export interface GraphEvent {
  seq: number;
  node_id: Identifier;
  edge_id: Identifier;
  outcome_code: OutcomeCode;
  elapsed_ms: number;
  evidence_seq: number | null;
}
export interface GraphProjection {
  schema_version: 1;
  graph_kind: "worker" | "optimizer";
  graph_version: Identifier;
  /**
   * @minItems 0
   * @maxItems 120
   */
  events: GraphEvent[];
}
export interface ExecuteTaskResponse {
  schema_version: 1;
  run: RunEnvelope;
  graph: GraphProjection;
}
export interface CheckpointRequest {
  schema_version: 1;
  work_id: Uuid;
  fence: number;
  graph_version: Identifier;
  state_version: 1;
  operation: "read" | "write";
  seq: number;
  write_key: Identifier;
  state: {
    [k: string]: unknown | undefined;
  } | null;
}
export interface CheckpointResponse {
  schema_version: 1;
  thread_id: Digest;
  input_digest: Digest;
  state: {
    [k: string]: unknown | undefined;
  } | null;
}
export interface DiagnosisEvent {
  seq: number;
  kind: "tool_request" | "tool_result" | "policy_decision" | "fault" | "recovery";
  code: OutcomeCode;
  tool: ToolName | null;
}
export interface DiagnosisRun {
  run_id: Uuid;
  task_key: TaskKey;
  success: boolean;
  tool_calls: number;
  cost_micros: number;
  /**
   * @minItems 0
   * @maxItems 60
   */
  reasons: OutcomeCode[];
  /**
   * @minItems 0
   * @maxItems 150
   */
  events: DiagnosisEvent[];
}
export interface AnalyzeDevRequest {
  schema_version: 1;
  /**
   * @minItems 1
   * @maxItems 30
   */
  runs: DiagnosisRun[];
}
export interface FailureCluster {
  signature:
    "schema_before_discovery" | "blocked_repeat" | "unrecovered_fault" | "evidence_gap" | "excess_efficiency_calls";
  count: number;
  /**
   * @minItems 2
   * @maxItems 3
   */
  evidence_refs: EventRef[];
}
export interface DevDiagnosis {
  schema_version: 1;
  /**
   * @minItems 0
   * @maxItems 5
   */
  clusters: FailureCluster[];
  /**
   * @minItems 0
   * @maxItems 3
   */
  counterexamples: EventRef[];
  metrics: {
    scheduled: number;
    successes: number;
    tool_calls: number;
    cost_micros: number;
    invalid_sql: number;
    sql_calls: number;
    faults: number;
    recoveries: number;
  };
}
export interface MutableHarness {
  prompt: {
    task_guidance: string;
  };
  workflow: {
    schema_inspection: "on_error" | "before_first_sql";
    verify_numeric_answers: boolean;
    retry_policy: "none" | "error_aware";
  };
  context: {
    recent_tool_results: number;
  };
  limits: {
    max_tool_calls: number;
    max_retries_per_tool: number;
  };
}
export interface OptimizeRequest {
  schema_version: 1;
  mode: Mode;
  parent: MutableHarness;
  diagnosis: DevDiagnosis;
  model: ModelSettings | null;
}
export interface ProposalDisposition {
  ordinal: number;
  proposal: Proposal | null;
  reason: OutcomeCode | null;
  candidate_view_digest: Digest | null;
}
export interface OptimizeResponse {
  schema_version: 1;
  /**
   * @minItems 0
   * @maxItems 3
   */
  dispositions: ProposalDisposition[];
  graph: GraphProjection;
  usage: ModelUsage;
}
