package blisrun

import (
	"reflect"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// Scenario-locating paths the runner resolves and passes verbatim. Argv is a pure
// function of these plus the declared inputs.
const (
	scnDir = "/tmp/scn"
	scnF   = "s.yaml"
	reg    = "/reg"
	cat    = "/cat"
)

// argvFor is Argv with the scenario/registry/catalog paths fixed, so each test states
// only the group, deployment and run paths it varies.
func argvFor(g schema.Group, d schema.Deployment, metricsPath, specPath, kvOffloadPath string) []string {
	return Argv("./blis", scnDir, scnF, reg, cat, g, d, metricsPath, specPath, kvOffloadPath)
}

// group is a workload-spec comparability group — the only synthetic variant now (the flat
// gaussian shorthand is lowered to one of these before a run). Argv reads the offered load
// from the spec file, so the inline spec content here is immaterial to the command line.
func group() schema.Group {
	spec := map[string]any{
		"version": "2", "category": "language", "aggregate_rate": 6.0, "num_requests": 500,
		"clients": []any{map[string]any{"id": "c0", "rate_fraction": 1.0}},
	}
	sha, _ := schema.SpecSHA256(spec)
	return schema.Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type:           "workload-spec",
			ArrivalProcess: "constant",
			Load:           schema.Load{Kind: "rate"},
			SpecSHA256:     &sha,
			Spec:           spec,
		},
	}
}

// deployment carries the full candidate; since v0.10.0 the model/hardware/parallelism and
// engine knobs are rendered into the scenario file (not the argv), so Argv reflects only
// the surviving CLI knobs: num-instances and the scheduling/routing/admission block.
func deployment() schema.Deployment {
	return schema.Deployment{
		Model:    "qwen/qwen3-14b",
		Hardware: "h100", TP: 2, DP: 1, NumInstances: 1,
		MaxModelLen: 40960, BlockSizeInTokens: 16,
		MaxNumSeqs: 256, MaxNumBatchedTokens: 8192,
		LongPrefillTokenThreshold: 0,
		Scheduler:                 "fcfs", PreemptionPolicy: "fcfs",
		RoutingPolicy: "round-robin", AdmissionPolicy: "always-admit",
		KVCacheDtype: "auto", LatencyModel: "trained-physics",
		GPUMemoryUtilization: 0.9,
		ExtraFlags:           map[string]string{},
	}
}

func TestArgvIsExactAndComplete(t *testing.T) {
	got := argvFor(group(), deployment(), "/tmp/m.json", "/tmp/spec.yaml", "")
	want := []string{
		"./blis", "run",
		"--scenarios", scnDir, "--scenario", scnF, "--registry", reg, "--catalog", cat,
		"--workload-spec", "/tmp/spec.yaml",
		"--seed", "42",
		"--timeout", "300",
		"--num-instances", "1",
		"--long-prefill-token-threshold", "0",
		"--scheduler", "fcfs",
		"--preemption-policy", "fcfs",
		"--routing-policy", "round-robin",
		"--admission-policy", "always-admit",
		"--metrics-path", "/tmp/m.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", got, want)
	}
}

// The engine knobs moved into the scenario file: they must NOT reappear as CLI flags, nor
// must the removed --latency-model, and --model/--hardware are gone entirely.
func TestArgvDropsScenarioAndRemovedFlags(t *testing.T) {
	joined := strings.Join(argvFor(group(), deployment(), "/tmp/m.json", "/tmp/spec.yaml", ""), " ")
	for _, flag := range []string{
		"--model", "--hardware", "--tp", "--dp",
		"--max-model-len", "--block-size-in-tokens", "--max-num-seqs", "--max-num-batched-tokens",
		"--kv-cache-dtype", "--gpu-memory-utilization", "--latency-model", "--total-kv-blocks",
	} {
		if strings.Contains(joined, flag) {
			t.Errorf("%q belongs in the scenario or is removed, not the argv: %s", flag, joined)
		}
	}
}

// The scenario is located first, so a stored argv reads deployment-then-everything-else.
func TestArgvLeadsWithScenario(t *testing.T) {
	got := argvFor(group(), deployment(), "/tmp/m.json", "/tmp/spec.yaml", "")
	want := []string{"./blis", "run", "--scenarios", scnDir, "--scenario", scnF, "--registry", reg, "--catalog", cat}
	if !reflect.DeepEqual(got[:len(want)], want) {
		t.Errorf("argv must lead with run + scenario locators, got %v", got[:len(want)])
	}
}

// --metrics-path is not optional: cache_hit_rate and requests[] are written only to
// the file branch of EmitOutput, so a stdout capture is a lesser record.
func TestArgvAlwaysCarriesMetricsPath(t *testing.T) {
	got := argvFor(group(), deployment(), "/tmp/m.json", "", "")
	if got[len(got)-2] != "--metrics-path" || got[len(got)-1] != "/tmp/m.json" {
		t.Errorf("argv must end with --metrics-path <path>, got %v", got[len(got)-2:])
	}
}

func TestArgvEmitsHorizonOnlyWhenSet(t *testing.T) {
	joined := strings.Join(argvFor(group(), deployment(), "/tmp/m.json", "", ""), " ")
	if strings.Contains(joined, "--horizon") {
		t.Errorf("unset horizon must not appear: %s", joined)
	}
	g := group()
	h := int64(20000000)
	g.HorizonTicks = &h
	joined = strings.Join(argvFor(g, deployment(), "/tmp/m.json", "", ""), " ")
	if !strings.Contains(joined, "--horizon 20000000") {
		t.Errorf("missing --horizon: %s", joined)
	}
}

// A workload-spec group runs blis via --workload-spec; the synthetic distribution flags
// must not appear — the spec supersedes them, and passing the placeholder zeros would
// override the spec's own values.
func TestArgvWorkloadSpecReplacesDistributionFlags(t *testing.T) {
	g := group()
	sha := "0000000000000000000000000000000000000000000000000000000000000000"
	g.Workload = schema.Workload{
		Type:       "workload-spec",
		SpecSHA256: &sha,
		Spec:       map[string]any{"version": "2", "aggregate_rate": 20},
	}
	got := argvFor(g, deployment(), "/tmp/m.json", "/tmp/spec.yaml", "")
	joined := strings.Join(got, " ")

	if !strings.Contains(joined, "--workload-spec /tmp/spec.yaml") {
		t.Errorf("missing --workload-spec: %s", joined)
	}
	// The deployment is now the scenario, not --model/--hardware on the CLI.
	if !strings.Contains(joined, "--scenario "+scnF) {
		t.Errorf("the deployment must be located via --scenario: %s", joined)
	}
	// Seed and timeout are group-side and override the spec; keep them.
	if !strings.Contains(joined, "--seed 42") || !strings.Contains(joined, "--timeout 300") {
		t.Errorf("seed/timeout must be passed: %s", joined)
	}
	for _, flag := range []string{"--workload distribution", "--num-requests", "--rate", "--concurrency",
		"--prompt-tokens", "--output-tokens"} {
		if strings.Contains(joined, flag) {
			t.Errorf("distribution flag %q leaked into a spec run: %s", flag, joined)
		}
	}
	if got[len(got)-2] != "--metrics-path" || got[len(got)-1] != "/tmp/m.json" {
		t.Errorf("--metrics-path must stay last: %v", got[len(got)-2:])
	}
}

// long-prefill-token-threshold is always emitted; a 0 threshold is a valid "off", passed
// rather than dropped.
func TestArgvEmitsLongPrefillAlways(t *testing.T) {
	d := deployment()
	d.LongPrefillTokenThreshold = 2048
	joined := strings.Join(argvFor(group(), d, "/tmp/m.json", "", ""), " ")
	if !strings.Contains(joined, "--long-prefill-token-threshold 2048") {
		t.Errorf("missing --long-prefill-token-threshold: %s", joined)
	}
}

// --routing-scorers is emitted only for the weighted policy, and only when a profile is
// present, so a non-weighted record's argv is unchanged. The pairs are name:weight, joined
// with commas, in the order the profile declares them.
func TestArgvRoutingScorersOnlyWhenWeighted(t *testing.T) {
	d := deployment()
	d.RoutingScorers = []schema.ScorerConfig{{Name: "queue-depth", Weight: 1}}
	off := strings.Join(argvFor(group(), d, "/tmp/m.json", "", ""), " ")
	if strings.Contains(off, "--routing-scorers") {
		t.Errorf("a non-weighted policy must not emit --routing-scorers: %s", off)
	}

	w := deployment()
	w.RoutingPolicy = "weighted"
	none := strings.Join(argvFor(group(), w, "/tmp/m.json", "", ""), " ")
	if strings.Contains(none, "--routing-scorers") {
		t.Errorf("weighted with an empty profile must not emit the flag: %s", none)
	}
	if !strings.Contains(none, "--routing-policy weighted") {
		t.Errorf("missing --routing-policy weighted: %s", none)
	}

	w.RoutingScorers = []schema.ScorerConfig{
		{Name: "precise-prefix-cache", Weight: 2},
		{Name: "queue-depth", Weight: 1},
		{Name: "kv-utilization", Weight: 1.5},
	}
	on := argvFor(group(), w, "/tmp/m.json", "", "")
	joined := strings.Join(on, " ")
	if !strings.Contains(joined, "--routing-scorers precise-prefix-cache:2,queue-depth:1,kv-utilization:1.5") {
		t.Errorf("weighted profile not spelled out as name:weight pairs: %s", joined)
	}
	iScorers := indexOf(on, "--routing-scorers")
	iAdmission := indexOf(on, "--admission-policy")
	if iScorers < 0 || iAdmission < 0 || iScorers > iAdmission {
		t.Errorf("--routing-scorers must precede --admission-policy: %v", on)
	}
}

func indexOf(a []string, s string) int {
	for i, v := range a {
		if v == s {
			return i
		}
	}
	return -1
}

// KV-cache CPU offloading emits --kv-offload-config with the given path only when the
// deployment carries a kv_offload block, following the "emit when the capability is on"
// rule, and rides just before --metrics-path.
func TestArgvKVOffloadConfig(t *testing.T) {
	off := strings.Join(argvFor(group(), deployment(), "/tmp/m.json", "", "/tmp/o.yaml"), " ")
	if strings.Contains(off, "--kv-offload-config") {
		t.Errorf("a non-offloading deployment must not emit --kv-offload-config: %s", off)
	}

	d := deployment()
	d.KVOffload = &schema.KVOffload{
		CPUBytesToUse: 1 << 30, BlockSize: 16, BlocksPerChunk: 1, TokensPerHash: 16,
		EvictionPolicy: "lru", OffloadPromptOnly: true,
	}
	got := argvFor(group(), d, "/tmp/m.json", "", "/tmp/o.yaml")
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "--kv-offload-config /tmp/o.yaml") {
		t.Errorf("missing --kv-offload-config with its path: %s", joined)
	}
	i := indexOf(got, "--kv-offload-config")
	if i < 0 || got[i+1] != "/tmp/o.yaml" {
		t.Errorf("--kv-offload-config must be followed by its path: %v", got)
	}
	if got[len(got)-2] != "--metrics-path" {
		t.Errorf("--metrics-path must remain last: %v", got[len(got)-2:])
	}
}

// Extra flags are appended in sorted order so the argv — and therefore the record —
// is reproducible.
func TestArgvAppendsExtraFlagsSorted(t *testing.T) {
	d := deployment()
	d.ExtraFlags = map[string]string{"prefix-tokens": "64", "enforce-eager": "true"}
	got := argvFor(group(), d, "/tmp/m.json", "", "")
	joined := strings.Join(got, " ")
	iEager := strings.Index(joined, "--enforce-eager true")
	iPrefix := strings.Index(joined, "--prefix-tokens 64")
	if iEager < 0 || iPrefix < 0 {
		t.Fatalf("extra flags missing: %s", joined)
	}
	if iEager > iPrefix {
		t.Errorf("extra flags not sorted: %s", joined)
	}
	if strings.Index(joined, "--metrics-path") < iPrefix {
		t.Errorf("--metrics-path must stay last: %s", joined)
	}
}

// Argv must be a pure function of its inputs: BLIS is deterministic, and a record
// whose argv drifted would make a real output diff look like noise.
func TestArgvIsDeterministic(t *testing.T) {
	d := deployment()
	d.ExtraFlags = map[string]string{"a": "1", "b": "2", "c": "3"}
	first := argvFor(group(), d, "/tmp/m.json", "", "")
	for i := 0; i < 20; i++ {
		if got := argvFor(group(), d, "/tmp/m.json", "", ""); !reflect.DeepEqual(got, first) {
			t.Fatalf("argv varied between calls:\n%v\n%v", first, got)
		}
	}
}
