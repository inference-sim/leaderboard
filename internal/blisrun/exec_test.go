package blisrun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// A trimmed but real blis metrics file: the 27 required fields, one omitempty
// field, and requests[].
const blisOutput = `{
  "instance_id": "cluster",
  "completed_requests": 500, "still_queued": 0, "still_running": 0,
  "injected_requests": 500, "total_input_tokens": 248510, "total_output_tokens": 93040,
  "vllm_estimated_duration_s": 86.2, "responses_per_sec": 5.8, "tokens_per_sec": 1078.9,
  "e2e_mean_ms": 1358.9, "e2e_p90_ms": 3229.5, "e2e_p95_ms": 4197.8, "e2e_p99_ms": 5265.8,
  "ttft_mean_ms": 27.4, "ttft_p90_ms": 30.1, "ttft_p95_ms": 30.8, "ttft_p99_ms": 31.4,
  "itl_mean_ms": 7.19, "itl_p90_ms": 7.4, "itl_p95_ms": 8.0, "itl_p99_ms": 8.69,
  "scheduling_delay_p99_ms": 22.5, "preemption_count": 0,
  "dropped_unservable": 0, "length_capped_requests": 0, "timed_out_requests": 0,
  "cache_hit_rate": 0.42,
  "requests": [{"request_id": "r0", "e2e_ms": 1200.0}, {"request_id": "r1", "e2e_ms": 1300.0}]
}`

// writeKVOffloadFile writes a top-level kv_offload: block with every CPU-tier key, at an
// absolute path beside the metrics file, so blis (which strict-parses the config and
// resolves the path relative to its own cwd) accepts it.
func TestWriteKVOffloadFile(t *testing.T) {
	dir := t.TempDir()
	metricsPath := filepath.Join(dir, "run.json")
	kv := &schema.KVOffload{
		CPUBytesToUse: 1 << 30, BlockSize: 32, BlocksPerChunk: 2, TokensPerHash: 32,
		EvictionPolicy: "arc", OffloadPromptOnly: false, SelfDescribingKVEvents: true,
	}
	path, err := writeKVOffloadFile(kv, metricsPath)
	if err != nil {
		t.Fatalf("writeKVOffloadFile: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Errorf("path must be absolute for blis's cwd: %s", path)
	}
	if got, want := filepath.Base(path), "run.kv-offload.yaml"; got != want {
		t.Errorf("path basename = %q, want %q", got, want)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	s := string(body)
	if !strings.HasPrefix(strings.TrimSpace(s), "kv_offload:") {
		t.Errorf("config must have a top-level kv_offload: block:\n%s", s)
	}
	for _, want := range []string{
		"cpu_bytes_to_use: 1073741824", "block_size: 32", "blocks_per_chunk: 2",
		"tokens_per_hash: 32", "eviction_policy: arc", "offload_prompt_only: false",
		"self_describing_kv_events: true",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("config missing %q:\n%s", want, s)
		}
	}
}

func TestSplitMetricsKeepsCoreAndStripsRequests(t *testing.T) {
	core, raw, requests, err := SplitMetrics([]byte(blisOutput))
	if err != nil {
		t.Fatalf("SplitMetrics: %v", err)
	}

	if core.CompletedRequests != 500 || core.E2EP99Ms != 5265.8 || core.InstanceID != "cluster" {
		t.Errorf("core metrics wrong: %+v", core)
	}
	// requests[] is 97% of the bytes and a table needs none of it.
	if _, ok := raw["requests"]; ok {
		t.Error("metrics_raw must not carry requests[]")
	}
	// An omitempty field is not in the core, and must survive verbatim.
	if got, ok := raw["cache_hit_rate"]; !ok || got != 0.42 {
		t.Errorf("cache_hit_rate = %v (present %v), want 0.42 in metrics_raw", got, ok)
	}
	if _, ok := raw["completed_requests"]; !ok {
		t.Error("metrics_raw is everything blis emitted, core fields included")
	}
	if len(requests) == 0 {
		t.Error("requests[] should be returned for the sidecar, not discarded")
	}
	var parsed []map[string]any
	if err := json.Unmarshal(requests, &parsed); err != nil {
		t.Fatalf("sidecar payload is not valid JSON: %v", err)
	}
	if len(parsed) != 2 {
		t.Errorf("sidecar has %d requests, want 2", len(parsed))
	}
}

// The two KV JSON fields are optional typed metrics, not required core: BLIS emits
// cache_hit_rate for every run going forward but omitempty guards older records, and
// kv_allocation_failures is omitted entirely when zero. SplitMetrics must decode them
// onto Metrics when present and leave the zero value (nil pointer, 0 count) when absent,
// never rejecting a run that omits them.
func TestSplitMetricsDecodesOptionalKVFields(t *testing.T) {
	withFailures := strings.Replace(blisOutput,
		`"cache_hit_rate": 0.42,`,
		`"cache_hit_rate": 0.42, "kv_allocation_failures": 7,`, 1)
	core, _, _, err := SplitMetrics([]byte(withFailures))
	if err != nil {
		t.Fatalf("SplitMetrics: %v", err)
	}
	if core.CacheHitRate == nil {
		t.Fatal("cache_hit_rate present in the file but nil on Metrics")
	}
	if *core.CacheHitRate != 0.42 {
		t.Errorf("cache_hit_rate = %v, want 0.42", *core.CacheHitRate)
	}
	if core.KVAllocationFailures != 7 {
		t.Errorf("kv_allocation_failures = %d, want 7", core.KVAllocationFailures)
	}
}

// A run from an older BLIS (or any run whose prefix cache never engaged) omits
// cache_hit_rate, and every healthy run omits kv_allocation_failures. Neither absence
// is an error: nil distinguishes "not reported" from "reported 0.0", and a zero count
// is the healthy default.
func TestSplitMetricsAcceptsAbsentKVFields(t *testing.T) {
	withoutCacheHit := strings.Replace(blisOutput, `"cache_hit_rate": 0.42,`, "", 1)
	core, _, _, err := SplitMetrics([]byte(withoutCacheHit))
	if err != nil {
		t.Fatalf("a run without cache_hit_rate must still be accepted: %v", err)
	}
	if core.CacheHitRate != nil {
		t.Errorf("cache_hit_rate absent but non-nil: %v", *core.CacheHitRate)
	}
	if core.KVAllocationFailures != 0 {
		t.Errorf("kv_allocation_failures absent but %d, want 0", core.KVAllocationFailures)
	}
}

func TestSplitMetricsRejectsAMissingCoreField(t *testing.T) {
	stripped := strings.Replace(blisOutput, `"ttft_p99_ms": 31.4,`, "", 1)
	_, _, _, err := SplitMetrics([]byte(stripped))
	if err == nil {
		t.Fatal("expected an error naming the missing field")
	}
	if !strings.Contains(err.Error(), "ttft_p99_ms") {
		t.Errorf("error should name the missing field, got %v", err)
	}
}

func TestSplitMetricsRejectsGarbage(t *testing.T) {
	if _, _, _, err := SplitMetrics([]byte("not json")); err == nil {
		t.Fatal("expected a parse error")
	}
}

func TestSplitMetricsWithNoRequestsReturnsNoSidecar(t *testing.T) {
	var m map[string]any
	if err := json.Unmarshal([]byte(blisOutput), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	delete(m, "requests")
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	_, raw, requests, err := SplitMetrics(body)
	if err != nil {
		t.Fatalf("SplitMetrics: %v", err)
	}
	if requests != nil {
		t.Errorf("requests = %s, want nil", requests)
	}
	if _, ok := raw["cache_hit_rate"]; !ok {
		t.Error("metrics_raw lost cache_hit_rate")
	}
}

// The end-to-end runner needs a real blis, so it is gated. It is also the only
// place the plan's C5 finding is checked against the simulator: --timeout 3 must
// still produce timed_out_requests, and the record must be disqualified for it.
// TestRunFinalizesWorkloadSpecSHA is hermetic: a stub binary stands in for blis and
// writes a known metrics file, so the test exercises Run's record-building without the
// simulator. It pins the fix for the custom card, which posts a workload-spec group with
// its inline spec but no spec_sha256 (the browser cannot compute the Go content hash). Run
// must fill it from the spec itself, or the record fails schema validation with
// "spec_sha256: got null, want string".
func TestRunFinalizesWorkloadSpecSHA(t *testing.T) {
	dir := t.TempDir()
	// A stub that behaves like blis for this test: write the fixture metrics to the last
	// argument (Argv puts the metrics path last), ignoring every flag.
	stub := filepath.Join(dir, "blis-stub.sh")
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncat > \"$last\" <<'JSON'\n" + blisOutput + "\nJSON\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	// commit/binarySHA256 satisfy the record's provenance patterns; the point of the test
	// is the workload block, not provenance, so any well-formed values do.
	r := &Runner{Binary: stub, Cwd: dir, commit: "abcdef1", binarySHA256: "0123456789abcdef"}

	spec := map[string]any{
		"version":        "2",
		"aggregate_rate": 6,
		"num_requests":   100,
		"clients": []any{map[string]any{
			"id":                  "c0",
			"rate_fraction":       1,
			"arrival":             map[string]any{"process": "poisson"},
			"input_distribution":  map[string]any{"type": "gaussian", "params": map[string]any{"mean": 8000, "std_dev": 512, "min": 1, "max": 10048}},
			"output_distribution": map[string]any{"type": "gaussian", "params": map[string]any{"mean": 1000, "std_dev": 256, "min": 1, "max": 2024}},
		}},
	}
	// The group the custom card posts: a workload-spec with the inline spec and NO sha.
	g := schema.Group{
		Seed: 42, RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type: "workload-spec", ArrivalProcess: "constant",
			Load: schema.Load{Kind: "rate", Value: 0},
			Spec: spec,
		},
	}
	d := schema.Deployment{
		Model:    "qwen/qwen3-14b",
		Hardware: "L40S", TP: 1, DP: 1, NumInstances: 1,
		MaxModelLen: 40960, BlockSizeInTokens: 16, MaxNumSeqs: 256,
		MaxNumBatchedTokens: 8192, LongPrefillTokenThreshold: 0,
		Scheduler: "fcfs", PreemptionPolicy: "fcfs",
		RoutingPolicy: "round-robin", AdmissionPolicy: "always-admit",
		KVCacheDtype: "auto", LatencyModel: "trained-physics",
		GPUMemoryUtilization: 0.9,
		ExtraFlags:           map[string]string{},
	}

	rec, err := r.Run(g, RunSpec{RunID: "spec-run", Deployment: d}, filepath.Join(dir, "m.json"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if rec.Group.Workload.SpecSHA256 == nil {
		t.Fatal("workload-spec record has a nil spec_sha256; Run did not finalize it")
	}
	want, err := schema.SpecSHA256(spec)
	if err != nil {
		t.Fatalf("SpecSHA256: %v", err)
	}
	if *rec.Group.Workload.SpecSHA256 != want {
		t.Errorf("spec_sha256 = %q, want %q (the content hash of the inline spec)", *rec.Group.Workload.SpecSHA256, want)
	}
	// The regression: without the finalized sha the schema rejects the record.
	if err := schema.ValidateRecord(rec); err != nil {
		t.Errorf("runner produced a record the schema rejects: %v", err)
	}
}

// Run must scrape the KV thrashing rate from BLIS's stdout — the one KV signal that is
// neither in the metrics file nor derivable from it — and carry it on the record. This
// is hermetic: a stub stands in for blis, writing the fixture metrics to the metrics
// path (Argv puts it last) and printing the human KV Cache Metrics section to stdout,
// exactly as printKVCacheMetrics does upstream.
func TestRunScrapesKVThrashingFromStdout(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "blis-stub.sh")
	script := "#!/bin/sh\n" +
		"for a in \"$@\"; do last=\"$a\"; done\n" +
		"cat > \"$last\" <<'JSON'\n" + blisOutput + "\nJSON\n" +
		"echo '=== KV Cache Metrics ==='\n" +
		"echo 'Preemption Rate: 0.0120'\n" +
		"echo 'Cache Hit Rate: 0.4200'\n" +
		"echo 'KV Thrashing Rate: 0.0345'\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	r := &Runner{Binary: stub, Cwd: dir, commit: "abcdef1", binarySHA256: "0123456789abcdef"}

	g := schema.Group{
		Seed: 42, RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type: "distribution", ArrivalProcess: "constant", NumRequests: 500,
			Load:         schema.Load{Kind: "rate", Value: 6.0},
			PromptTokens: 512, PromptTokensStdev: 128,
			OutputTokens: 128, OutputTokensStdev: 32,
		},
	}
	d := schema.Deployment{
		Model:    "qwen/qwen3-14b",
		Hardware: "L40S", TP: 1, DP: 1, NumInstances: 1,
		MaxModelLen: 40960, BlockSizeInTokens: 16, MaxNumSeqs: 256,
		MaxNumBatchedTokens: 8192, LongPrefillTokenThreshold: 0,
		Scheduler: "fcfs", PreemptionPolicy: "fcfs",
		RoutingPolicy: "round-robin", AdmissionPolicy: "always-admit",
		KVCacheDtype: "auto", LatencyModel: "trained-physics",
		GPUMemoryUtilization: 0.9,
		ExtraFlags:           map[string]string{},
	}

	rec, err := r.Run(g, RunSpec{RunID: "kv-run", Deployment: d}, filepath.Join(dir, "m.json"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if rec.KVThrashingRate == nil {
		t.Fatal("KV Thrashing Rate printed to stdout but the record's kv_thrashing_rate is nil")
	}
	if *rec.KVThrashingRate != 0.0345 {
		t.Errorf("kv_thrashing_rate = %v, want 0.0345", *rec.KVThrashingRate)
	}
	if err := schema.ValidateRecord(rec); err != nil {
		t.Errorf("runner produced a record the schema rejects: %v", err)
	}
}

// When BLIS prints no KV Cache Metrics section (all three rates zero), the scraped rate
// is nil and the record simply omits it — never a spurious zero. The workload-spec stub
// already prints nothing to stdout, so this pins the absence path through Run.
func TestRunOmitsKVThrashingWhenStdoutHasNoSection(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "blis-stub.sh")
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncat > \"$last\" <<'JSON'\n" + blisOutput + "\nJSON\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	r := &Runner{Binary: stub, Cwd: dir, commit: "abcdef1", binarySHA256: "0123456789abcdef"}
	g := schema.Group{
		Seed: 42, RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type: "distribution", ArrivalProcess: "constant", NumRequests: 500,
			Load:         schema.Load{Kind: "rate", Value: 6.0},
			PromptTokens: 512, PromptTokensStdev: 128,
			OutputTokens: 128, OutputTokensStdev: 32,
		},
	}
	d := schema.Deployment{
		Model: "qwen/qwen3-14b", Hardware: "L40S", TP: 1, DP: 1, NumInstances: 1,
		MaxModelLen: 40960, BlockSizeInTokens: 16, MaxNumSeqs: 256,
		MaxNumBatchedTokens: 8192, LongPrefillTokenThreshold: 0,
		Scheduler: "fcfs", PreemptionPolicy: "fcfs",
		RoutingPolicy: "round-robin", AdmissionPolicy: "always-admit",
		KVCacheDtype: "auto", LatencyModel: "trained-physics",
		GPUMemoryUtilization: 0.9, ExtraFlags: map[string]string{},
	}
	rec, err := r.Run(g, RunSpec{RunID: "kv-run-none", Deployment: d}, filepath.Join(dir, "m.json"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if rec.KVThrashingRate != nil {
		t.Errorf("no KV section but kv_thrashing_rate = %v, want nil", *rec.KVThrashingRate)
	}
}

func TestIntegrationRunProducesADisqualifiedTimeoutRecord(t *testing.T) {
	if os.Getenv("LEADERBOARD_INTEGRATION") == "" {
		t.Skip("set LEADERBOARD_INTEGRATION=1 and run `make blis` first")
	}
	cwd := filepath.Join("..", "..", Cwd)
	r, err := NewRunner(cwd)
	if err != nil {
		t.Fatalf("NewRunner: %v", err)
	}

	g := schema.Group{
		Seed: 42, RequestTimeoutS: 3,
		Workload: schema.Workload{
			Type: "distribution", ArrivalProcess: "constant", NumRequests: 200,
			Load:         schema.Load{Kind: "rate", Value: 6.0},
			PromptTokens: 512, PromptTokensStdev: 128,
			OutputTokens: 128, OutputTokensStdev: 32,
		},
	}
	d := schema.Deployment{
		Model:    "qwen/qwen3-14b",
		Hardware: "L40S", TP: 1, DP: 1, NumInstances: 1,
		MaxModelLen: 40960, BlockSizeInTokens: 16, MaxNumSeqs: 256,
		MaxNumBatchedTokens: 8192, LongPrefillTokenThreshold: 0,
		Scheduler: "fcfs", PreemptionPolicy: "fcfs",
		RoutingPolicy: "round-robin", AdmissionPolicy: "always-admit",
		KVCacheDtype: "auto", LatencyModel: "trained-physics",
		GPUMemoryUtilization: 0.9,
		ExtraFlags:           map[string]string{},
	}

	rec, err := r.Run(g, RunSpec{RunID: "l40s-tp1-timeout3", Deployment: d},
		filepath.Join(t.TempDir(), "m.json"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if rec.Metrics.TimedOutRequests == 0 {
		t.Error("--timeout 3 produced no timeouts; spec question 2 needs revisiting")
	}
	if rec.Status.Complete {
		t.Error("a run that timed out requests must not be complete")
	}
	if err := schema.ValidateRecord(rec); err != nil {
		t.Errorf("runner produced a record the schema rejects: %v", err)
	}
	if rec.Provenance.Cwd != cwd {
		t.Errorf("provenance.cwd = %q, want %q (the cwd passed to NewRunner)", rec.Provenance.Cwd, cwd)
	}
	if rec.GroupID == "" || rec.WorkID == "" {
		t.Error("record is missing its ids")
	}
}
