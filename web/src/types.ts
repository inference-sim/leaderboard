/* GENERATED from ../schema/run.schema.json by npm run gen:types. Do not edit. */

/**
 * Two variants share this object, discriminated by `type` (§4). The base declares every field loosely; the value constraints that make a `distribution` workload well-formed live in the conditional below, so a `workload-spec` record — whose distribution fields are unused zeros — is not rejected by them. Keeping one object (rather than a oneOf) keeps the generated Workload a single type, so existing readers of `num_requests`/`load` are unchanged.
 */
export type Workload = {
  /**
   * --workload. `distribution` is the flat synthetic shape; `workload-spec` carries an inline blis WorkloadSpec in `spec` and reaches the full workload surface.
   */
  type: "distribution" | "workload-spec";
  /**
   * DERIVED, not reported: SynthesizeFromDistribution sets ArrivalSpec{Process: "constant"} for rate mode (../inference-sim/sim/workload/synthesis.go:33). Poisson is reachable only via --workload-spec. Not applicable to the spec variant (arrival lives inside `spec`), where it holds the placeholder "constant".
   */
  arrival_process: "constant" | "closed-loop";
  num_requests: number;
  load: Load;
  prompt_tokens: number;
  prompt_tokens_stdev: number;
  output_tokens: number;
  output_tokens_stdev: number;
  /**
   * --workload-spec provenance: the sibling file a spec was authored from, if any. A catalog-inline profile leaves it null and carries the spec in `spec`.
   */
  spec_file: string | null;
  /**
   * Content hash of the inline `spec`, folded into group_id. Null for the distribution variant.
   */
  spec_sha256: string | null;
  /**
   * The inline blis WorkloadSpec (v2), model-free, for the workload-spec variant. Absent for distribution.
   */
  spec?: {};
};

/**
 * One blis run: the work offered, the candidate under test, and what BLIS returned. Targets `blis run` / `blis replay` output only — the search tool's {config, metrics} shape would half-validate against this one.
 */
export interface BLISLeaderboardRunRecord {
  schema_version: 1;
  /**
   * Unique within a group; also the result filename.
   */
  run_id: string;
  /**
   * hash(group). Bounds one table.
   */
  group_id: string;
  /**
   * hash(group minus seed).
   */
  work_id: string;
  /**
   * The catalog name (a preset or saved profile) the run was declared with, for display only. Optional and not part of group_id/work_id, which hash the model-free group: the name never changes which table a run lands in. Absent for a runs.yaml run, which names no workload.
   */
  workload_name?: string;
  group: Group;
  deployment: Deployment;
  provenance: Provenance;
  status: Status;
  metrics: Metrics;
  /**
   * Everything blis emitted, verbatim, minus requests[] — which is 97% of the bytes and belongs in the sidecar.
   */
  metrics_raw: {};
  /**
   * Path to results/<group_id>/<run_id>.requests.json when retained.
   */
  requests_sidecar: string | null;
}
/**
 * The comparability key: the work offered. Model and hardware are deliberately absent (D4, E1): both are candidates under test, so a table is one workload spanning models and hardware.
 */
export interface Group {
  seed: number;
  /**
   * --horizon. null = unbounded. Bounds the observation window, so it bounds the group (A4).
   */
  horizon_ticks: number | null;
  /**
   * --timeout. Negative disables it; 0 is rejected by blis.
   */
  request_timeout_s: number;
  workload: Workload;
}
/**
 * Exactly one kind, so an open-loop run and a closed-loop run can never share a group.
 */
export interface Load {
  kind: "rate" | "concurrency";
  /**
   * Offered load; > 0 for the distribution variant (enforced there). 0 is the not-applicable placeholder a workload-spec record carries.
   */
  value: number;
}
/**
 * The candidate under test. Every field is written even when it holds a BLIS default, so canonicalisation is stable and the UI can tell which fields vary across a table.
 */
export interface Deployment {
  /**
   * Org-prefixed, as defaults.yaml is keyed. A candidate dimension (E1): the reader filters and ranks it beside hardware.
   */
  model: string;
  /**
   * A key of ../inference-sim/hardware_config.json.
   */
  hardware: string;
  /**
   * Effectively required: trained-physics refuses to run without it.
   */
  tp: number;
  dp: number;
  /**
   * --enable-expert-parallel. MoE models only, --latency-model trained-physics only; blis fatally rejects it on a dense model. Omitted when false (the blis default), so a record without expert parallelism is canonically unchanged.
   */
  enable_expert_parallel?: boolean;
  /**
   * --moe-comm-backend. MoE all-to-all backend (latency.ValidMoECommBackends); needs a MoE model, trained-physics, and either dp>1 or enable_expert_parallel. "" means unset (blis default) and is omitted.
   */
  moe_comm_backend?:
    | ""
    | "naive"
    | "allgather_reducescatter"
    | "pplx"
    | "deepep_high_throughput"
    | "deepep_low_latency"
    | "mori"
    | "flashinfer_all2allv";
  num_instances: number;
  /**
   * Prefill/decode disaggregation (the PD pool topology and its KV-transfer physics). Present only when a pool is set — a non-disaggregated record omits it entirely, so its canonical form is unchanged (cf. routing_scorers, workload.spec). When present, the pool counts satisfy cluster.ValidatePoolTopology: their sum is <= num_instances, and prefill and decode are both set unless prefill_decode_instances (the shared-role pool) is.
   */
  disaggregation?: {
    /**
     * --prefill-instances. Instances dedicated to prefill (0 = none).
     */
    prefill_instances: number;
    /**
     * --decode-instances. Instances dedicated to decode (0 = none).
     */
    decode_instances: number;
    /**
     * --prefill-decode-instances. Shared-role instances serving both (llm-d 'both' parity; 0 = none).
     */
    prefill_decode_instances: number;
    /**
     * --pd-decider. When a request is disaggregated. Emitted when not "never".
     */
    decider: "never" | "always" | "prefix-threshold";
    /**
     * --pd-prefix-threshold. Non-cached-token threshold for the prefix-threshold decider (blis default 16); emitted only for that decider.
     */
    prefix_threshold: number;
    /**
     * --pd-transfer-bandwidth. KV transfer bandwidth in GB/s (blis default 25.0). Emitted when it differs from the default.
     */
    transfer_bandwidth: number;
    /**
     * --pd-transfer-base-latency. KV transfer base latency in ms (blis default 0.05). Emitted when it differs from the default.
     */
    transfer_base_latency: number;
    /**
     * --pd-transfer-contention. Fair-share bandwidth contention model. Emitted only when true.
     */
    transfer_contention: boolean;
  };
  /**
   * 0 = unlimited (blis auto-derives from the HF config).
   */
  max_model_len: number;
  block_size_in_tokens: number;
  max_num_seqs: number;
  /**
   * --max-num-batched-tokens. Upstream deprecated the --max-num-scheduled-tokens spelling.
   */
  max_num_batched_tokens: number;
  /**
   * --long-prefill-token-threshold. 0 = off (chunked prefill never triggers); blis accepts 0. Always emitted.
   */
  long_prefill_token_threshold: number;
  scheduler: "fcfs" | "priority-fcfs" | "sjf" | "reverse-priority";
  preemption_policy: "fcfs" | "priority";
  routing_policy: "round-robin" | "least-loaded" | "weighted" | "always-busiest";
  /**
   * --routing-scorers: the weighted policy's name:weight profile (mirrors sim.ScorerConfig). Omitted unless routing_policy is "weighted", and emitted to the argv as name:w,name:w only then — so a non-weighted record's canonical form is byte-for-byte unchanged (cf. workload.spec's omitempty). blis warns if it is set for any other policy, and falls back to precise-prefix-cache:2,queue-depth:1,kv-utilization:1 when weighted with none given.
   */
  routing_scorers?: {
    /**
     * A recognized blis scorer (sim.ValidScorerNames).
     */
    name:
      | "prefix-affinity"
      | "precise-prefix-cache"
      | "no-hit-lru"
      | "queue-depth"
      | "kv-utilization"
      | "load-balance"
      | "active-requests"
      | "running-requests"
      | "load-aware"
      | "vllm-dp"
      | "lora-affinity";
    /**
     * Finite and > 0; blis normalizes the weights to sum to 1.
     */
    weight: number;
  }[];
  admission_policy: "always-admit" | "token-bucket" | "reject-all" | "tier-shed" | "gaie-legacy";
  kv_cache_dtype: "auto" | "fp8" | "fp8_e4m3" | "fp8_e5m2" | "fp8_inc" | "bf16" | "fp16" | "fp32";
  latency_model: "trained-physics" | "roofline";
  /**
   * --gpu-memory-utilization. Fraction of GPU memory for the KV cache, in (0, 1.0]. Always emitted; blis default 0.9.
   */
  gpu_memory_utilization: number;
  /**
   * --num-speculative-tokens (K). 0 = speculative decoding off. Emitted only when > 0.
   */
  num_speculative_tokens: number;
  /**
   * --speculative-acceptance-rate. Mean fraction of draft tokens accepted, [0,1]. Emitted only when num_speculative_tokens > 0, where blis requires it.
   */
  speculative_acceptance_rate: number;
  /**
   * --speculative-method. blis closes the set (sim/config.go isValidSpeculativeMethod); "" means unset. Emitted only when num_speculative_tokens > 0 and non-empty.
   */
  speculative_method: "" | "mtp" | "eagle" | "medusa" | "ngram" | "draft";
  /**
   * Flag names without leading dashes. Part of row identity; the UI renders every entry (A3).
   */
  extra_flags: {
    [k: string]: string;
  };
}
export interface Provenance {
  blis_commit: string;
  /**
   * Recorded and surfaced as a caveat, never a reason to block a run.
   */
  blis_tree_dirty: boolean;
  binary_sha256: string;
  /**
   * @minItems 3
   */
  argv: [string, string, string, ...string[]];
  /**
   * The working directory blis was executed from — ../inference-sim in normal use. blis resolves defaults.yaml, hardware_config.json, and model_configs/ relative to this directory, so it is recorded rather than assumed.
   */
  cwd: string;
  ran_at: string;
  wall_s: number;
}
/**
 * Derived from metrics by internal/status, never asserted by hand.
 */
export interface Status {
  complete: boolean;
  disqualifications: Disqualification[];
  warnings: Warning[];
}
export interface Disqualification {
  code: "requests_dropped" | "requests_timed_out" | "window_ended_busy" | "injection_short" | "output_truncated";
  /**
   * incomplete: the declared work did not finish. altered: every request finished, but not the declared work.
   */
  class: "incomplete" | "altered";
  detail: string;
}
export interface Warning {
  code: "preemptions" | "accounting_mismatch";
  detail: string;
}
/**
 * Exactly the sim.MetricsOutput fields declared without omitempty — the 27 BLIS always emits. internal/drift asserts this list against upstream source. Everything omitempty (cache_hit_rate, kv_allocation_failures, goodput_rps, slo_attainment, per_class, adapters, saturation) lives in metrics_raw.
 */
export interface Metrics {
  instance_id: string;
  completed_requests: number;
  still_queued: number;
  still_running: number;
  /**
   * Upstream computes this as completed + queued + running + dropped + timed_out (sim/metrics.go:102) — an identity, not an independent count.
   */
  injected_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  vllm_estimated_duration_s: number;
  /**
   * Bounded above by the offered rate. Never rank on it.
   */
  responses_per_sec: number;
  /**
   * Also bounded by the offered rate at a single load.
   */
  tokens_per_sec: number;
  e2e_mean_ms: number;
  e2e_p90_ms: number;
  e2e_p95_ms: number;
  e2e_p99_ms: number;
  ttft_mean_ms: number;
  ttft_p90_ms: number;
  ttft_p95_ms: number;
  ttft_p99_ms: number;
  itl_mean_ms: number;
  itl_p90_ms: number;
  itl_p95_ms: number;
  itl_p99_ms: number;
  scheduling_delay_p99_ms: number;
  preemption_count: number;
  dropped_unservable: number;
  length_capped_requests: number;
  timed_out_requests: number;
}
