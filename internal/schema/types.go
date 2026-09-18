// Package schema is the contract binding BLIS's inputs to BLIS's outputs.
//
// BLIS emits metrics and never records the flags that produced them, so a result
// on its own cannot be compared with another result. A Record joins the two: the
// work offered (Group), the candidate under test (Deployment), and what BLIS
// returned (Metrics).
package schema

import "encoding/json"

// SchemaVersion is the only version this build reads or writes.
const SchemaVersion = 1

// Record is one blis run: one row of one leaderboard table.
type Record struct {
	SchemaVersion int    `json:"schema_version"`
	RunID         string `json:"run_id"`
	// GroupID is hash(Group). Every row of a table shares it.
	GroupID string `json:"group_id"`
	// WorkID is hash(Group minus seed), so a later variance view can aggregate
	// across seeds without a schema change.
	WorkID string `json:"work_id"`

	// WorkloadName is the catalog name of the workload this run was declared with
	// (a preset or a saved profile), for display only. It is metadata, not part of
	// the comparability key: GroupID/WorkID hash Group, which does not carry it, so a
	// name never changes which table a run lands in. omitempty because a run declared
	// from runs.yaml (or before this field existed) has no name, and its canonical
	// form must stay byte-for-byte unchanged.
	WorkloadName string `json:"workload_name,omitempty"`

	Group      Group      `json:"group"`
	Deployment Deployment `json:"deployment"`
	Provenance Provenance `json:"provenance"`
	Status     Status     `json:"status"`

	Metrics Metrics `json:"metrics"`
	// MetricsRaw is everything blis emitted, minus requests[], preserved verbatim.
	MetricsRaw map[string]any `json:"metrics_raw"`
	// RequestsSidecar is the path to the per-request file when it was retained.
	RequestsSidecar *string `json:"requests_sidecar"`
}

// Group is the comparability key: the work offered. Identical for every row of a
// table, and hashed into GroupID, so no code path can place two runs offered
// different work in the same table. Hardware and model are deliberately absent
// (D4, E1): both are candidates under test, so an H100-versus-L40S or a
// qwen-versus-glm table is the point. A table is one workload (E2).
type Group struct {
	Seed int64 `json:"seed"`
	// HorizonTicks bounds the observation window (--horizon), so it decides
	// whether the declared work can complete (A4). nil means unbounded.
	HorizonTicks *int64 `json:"horizon_ticks"`
	// RequestTimeoutS is --timeout: a per-request deadline, so it too decides
	// whether declared work completes. Not in the spec's §4; see the plan's
	// "one addition".
	RequestTimeoutS int      `json:"request_timeout_s"`
	Workload        Workload `json:"workload"`
}

// Workload is the request stream offered to every candidate.
type Workload struct {
	// Type is the --workload value. Only "distribution" is supported.
	Type string `json:"type"`
	// ArrivalProcess is derived, not reported: SynthesizeFromDistribution sets
	// ArrivalSpec{Process: "constant"} for rate mode
	// (../inference-sim/sim/workload/synthesis.go:33). It is displayed as a
	// derived value, never authored.
	ArrivalProcess string `json:"arrival_process"`
	NumRequests    int    `json:"num_requests"`
	Load           Load   `json:"load"`

	PromptTokens      int `json:"prompt_tokens"`
	PromptTokensStdev int `json:"prompt_tokens_stdev"`
	OutputTokens      int `json:"output_tokens"`
	OutputTokensStdev int `json:"output_tokens_stdev"`

	// SpecFile / SpecSHA256 reserve --workload-spec. SpecFile records provenance
	// when a spec was authored as a sibling file; a catalog-inline profile leaves it
	// nil and carries the spec in Spec instead.
	SpecFile   *string `json:"spec_file"`
	SpecSHA256 *string `json:"spec_sha256"`

	// Spec is the inline blis WorkloadSpec (v2) for a "workload-spec" workload,
	// model-free. It is omitempty so a "distribution" workload's canonical form — and
	// therefore every committed table's group_id — is byte-for-byte unchanged (P7).
	// group_id folds it in for the spec variant; SpecSHA256 is its content hash.
	Spec map[string]any `json:"spec,omitempty"`
}

// DeclaredRequests is the number of requests the group offered — the count a run's
// completeness is judged against. For a "distribution" workload it is NumRequests. For
// a "workload-spec" workload the flat NumRequests is a not-applicable placeholder zero
// (the real load lives in Spec), so it reads Spec["num_requests"]. The bool is false
// when the count is not a positive scalar — a spec that drives its load from cohort
// populations or a trace declares no single num_requests — so a caller can skip a check
// that would otherwise compare against zero.
func (w Workload) DeclaredRequests() (int, bool) {
	if w.Type != "workload-spec" {
		return w.NumRequests, true
	}
	n, ok := asInt(w.Spec["num_requests"])
	if !ok || n <= 0 {
		return 0, false
	}
	return n, true
}

// asInt coerces a JSON number out of a map[string]any to an int. A spec decoded from
// JSON carries float64, one decoded from YAML or built in Go carries int/int64, and a
// json.Number is possible too; all are accepted so the count is read the same however
// the spec reached us.
func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	default:
		return 0, false
	}
}

// Load is the offered load: exactly one kind, so a rate run and a concurrency run
// can never collide in one group.
type Load struct {
	Kind  string  `json:"kind"` // "rate" | "concurrency"
	Value float64 `json:"value"`
}

// ScorerConfig is one weighted-routing scorer and its weight, mirroring
// sim.ScorerConfig upstream. It appears in a Deployment only for the "weighted"
// routing policy; blis normalizes the weights across the profile to sum to 1.
type ScorerConfig struct {
	Name   string  `json:"name"`
	Weight float64 `json:"weight"`
}

// Disaggregation is a prefill/decode-disaggregated cluster: how the num_instances
// pods split into prefill-only, decode-only and shared-role pools, when a request is
// split (Decider), and the KV-transfer physics between the pools. It is present on a
// Deployment only when disaggregation is enabled (a pool count > 0); the counts obey
// cluster.ValidatePoolTopology. The transfer fields carry blis's defaults (25.0 GB/s,
// 0.05 ms) and are emitted only when they deviate, so the argv stays minimal.
type Disaggregation struct {
	PrefillInstances       int `json:"prefill_instances"`
	DecodeInstances        int `json:"decode_instances"`
	PrefillDecodeInstances int `json:"prefill_decode_instances"`
	// Decider is never | always | prefix-threshold.
	Decider string `json:"decider"`
	// PrefixThreshold is the non-cached-token threshold for the prefix-threshold
	// decider (blis default 16); it is emitted only for that decider.
	PrefixThreshold     int     `json:"prefix_threshold"`
	TransferBandwidth   float64 `json:"transfer_bandwidth"`
	TransferBaseLatency float64 `json:"transfer_base_latency"`
	TransferContention  bool    `json:"transfer_contention"`
}

// Deployment is the candidate under test: what varies across rows.
type Deployment struct {
	// Model is org-prefixed (e.g. qwen/qwen3-14b) and validated against the model
	// catalogue. It leads the deployment because it is the headline of a candidate
	// (E1): model joined hardware as a dimension the reader filters and ranks, so it
	// is no longer part of the comparability key.
	Model    string `json:"model"`
	Hardware string `json:"hardware"`
	TP       int    `json:"tp"`
	DP       int    `json:"dp"`

	// The MoE knobs. Both follow the omitempty-when-default rule: their blis defaults are
	// the zero values (false, ""), so a dense-model or non-MoE record omits them and its
	// canonical form is unchanged. blis fatally rejects EnableExpertParallel on a dense
	// model, and MoECommBackend needs a MoE model, trained-physics, and dp>1 or EP.
	EnableExpertParallel bool   `json:"enable_expert_parallel,omitempty"`
	MoECommBackend       string `json:"moe_comm_backend,omitempty"`

	NumInstances int `json:"num_instances"`

	// Disaggregation is the prefill/decode pool topology and its KV-transfer physics. It
	// follows the RoutingScorers precedent: a pointer, omitempty, set only when a pool is
	// declared, so a non-disaggregated deployment's canonical form — and twin-detection
	// against every stored record — is byte-for-byte unchanged.
	Disaggregation *Disaggregation `json:"disaggregation,omitempty"`

	MaxModelLen       int64 `json:"max_model_len"`
	BlockSizeInTokens int64 `json:"block_size_in_tokens"`
	MaxNumSeqs        int64 `json:"max_num_seqs"`
	// MaxNumBatchedTokens is --max-num-batched-tokens. The spec called this
	// max_num_scheduled_tokens, which upstream deprecated (C3).
	MaxNumBatchedTokens int64 `json:"max_num_batched_tokens"`
	// LongPrefillTokenThreshold is --long-prefill-token-threshold: the prefill length
	// beyond which chunked prefill triggers. 0 = off, and blis accepts 0, so it is
	// always emitted.
	LongPrefillTokenThreshold int64 `json:"long_prefill_token_threshold"`

	Scheduler string `json:"scheduler"`
	// PreemptionPolicy is fcfs or priority. The spec's "recompute" is not a
	// valid --preemption-policy value (C2).
	PreemptionPolicy string `json:"preemption_policy"`
	RoutingPolicy    string `json:"routing_policy"`
	// RoutingScorers is the weighted policy's name:weight profile (--routing-scorers).
	// It follows the Workload.Spec precedent rather than the "always written" rule: it
	// is omitempty, and the writers add it only for the "weighted" policy, so a
	// non-weighted deployment's canonical form — and therefore twin-detection against
	// every already-stored record — is byte-for-byte unchanged. blis warns if it is set
	// for any other policy, and falls back to its own default profile when weighted with
	// none given, which is why a weighted run always spells the profile out.
	RoutingScorers  []ScorerConfig `json:"routing_scorers,omitempty"`
	AdmissionPolicy string         `json:"admission_policy"`
	KVCacheDtype    string         `json:"kv_cache_dtype"`
	LatencyModel    string         `json:"latency_model"`

	// GPUMemoryUtilization is --gpu-memory-utilization: the fraction of GPU memory
	// given to the KV cache, in (0, 1.0]. Always emitted.
	GPUMemoryUtilization float64 `json:"gpu_memory_utilization"`

	// The speculative-decoding trio. blis treats the feature as off when
	// NumSpeculativeTokens == 0, and requires --speculative-acceptance-rate when it is
	// > 0. They follow the --dp precedent: present in every record's JSON, emitted to
	// the argv only when the capability is on, so a stored argv reproduces the record
	// without passing a meaningless --speculative-acceptance-rate 0.
	NumSpeculativeTokens int `json:"num_speculative_tokens"`
	// SpeculativeAcceptanceRate is the mean fraction of draft tokens accepted, [0,1].
	SpeculativeAcceptanceRate float64 `json:"speculative_acceptance_rate"`
	// SpeculativeMethod is an informational label; blis closes the set to
	// mtp|eagle|medusa|ngram|draft, with "" meaning unset.
	SpeculativeMethod string `json:"speculative_method"`

	// ExtraFlags is the escape hatch for any blis flag without a field here. It
	// is part of row identity and the UI renders every entry, so no two rows can
	// differ invisibly (A3). Keys are flag names without the leading dashes.
	ExtraFlags map[string]string `json:"extra_flags"`
}

// Provenance records what produced the numbers. A dirty upstream tree is recorded
// and surfaced, not blocked.
type Provenance struct {
	BlisCommit    string   `json:"blis_commit"`
	BlisTreeDirty bool     `json:"blis_tree_dirty"`
	BinarySHA256  string   `json:"binary_sha256"`
	Argv          []string `json:"argv"`
	Cwd           string   `json:"cwd"`
	RanAt         string   `json:"ran_at"`
	WallS         float64  `json:"wall_s"`
}

// Status is derived from Metrics by internal/status, never asserted by hand.
type Status struct {
	Complete          bool               `json:"complete"`
	Disqualifications []Disqualification `json:"disqualifications"`
	Warnings          []Warning          `json:"warnings"`
}

// Disqualification says why a run's percentiles describe a different job.
type Disqualification struct {
	Code string `json:"code"`
	// Class is "incomplete" (the run did not finish the declared work) or
	// "altered" (every request finished, but not the declared work).
	Class  string `json:"class"`
	Detail string `json:"detail"`
}

// Warning is a caveat that does not invalidate the numbers.
type Warning struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// Metrics is exactly the set of sim.MetricsOutput fields declared without
// omitempty: the 27 fields BLIS always emits. internal/drift asserts this list
// against upstream source, so the boundary is a property of the struct rather
// than a taste call.
type Metrics struct {
	InstanceID        string `json:"instance_id"`
	CompletedRequests int    `json:"completed_requests"`
	StillQueued       int    `json:"still_queued"`
	StillRunning      int    `json:"still_running"`
	InjectedRequests  int    `json:"injected_requests"`
	TotalInputTokens  int    `json:"total_input_tokens"`
	TotalOutputTokens int    `json:"total_output_tokens"`

	VllmEstimatedDurationS float64 `json:"vllm_estimated_duration_s"`
	ResponsesPerSec        float64 `json:"responses_per_sec"`
	TokensPerSec           float64 `json:"tokens_per_sec"`

	E2EMeanMs float64 `json:"e2e_mean_ms"`
	E2EP90Ms  float64 `json:"e2e_p90_ms"`
	E2EP95Ms  float64 `json:"e2e_p95_ms"`
	E2EP99Ms  float64 `json:"e2e_p99_ms"`

	TTFTMeanMs float64 `json:"ttft_mean_ms"`
	TTFTP90Ms  float64 `json:"ttft_p90_ms"`
	TTFTP95Ms  float64 `json:"ttft_p95_ms"`
	TTFTP99Ms  float64 `json:"ttft_p99_ms"`

	ITLMeanMs float64 `json:"itl_mean_ms"`
	ITLP90Ms  float64 `json:"itl_p90_ms"`
	ITLP95Ms  float64 `json:"itl_p95_ms"`
	ITLP99Ms  float64 `json:"itl_p99_ms"`

	SchedulingDelayP99Ms float64 `json:"scheduling_delay_p99_ms"`
	PreemptionCount      int64   `json:"preemption_count"`
	DroppedUnservable    int     `json:"dropped_unservable"`
	LengthCappedRequests int     `json:"length_capped_requests"`
	TimedOutRequests     int     `json:"timed_out_requests"`
}
