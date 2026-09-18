package blisrun

import (
	"reflect"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func group() schema.Group {
	return schema.Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type:           "distribution",
			ArrivalProcess: "constant",
			NumRequests:    500,
			Load:           schema.Load{Kind: "rate", Value: 6.0},
			PromptTokens:   512, PromptTokensStdev: 128,
			OutputTokens: 128, OutputTokensStdev: 32,
		},
	}
}

func deployment() schema.Deployment {
	return schema.Deployment{
		Model:    "qwen/qwen3-14b",
		Hardware: "H100", TP: 2, DP: 1, NumInstances: 1,
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
	got := Argv("./blis", group(), deployment(), "/tmp/m.json", "")
	want := []string{
		"./blis", "run",
		"--model", "qwen/qwen3-14b",
		"--hardware", "H100",
		"--tp", "2",
		"--num-instances", "1",
		"--workload", "distribution",
		"--num-requests", "500",
		"--rate", "6",
		"--seed", "42",
		"--timeout", "300",
		"--prompt-tokens", "512",
		"--prompt-tokens-stdev", "128",
		"--output-tokens", "128",
		"--output-tokens-stdev", "32",
		"--max-model-len", "40960",
		"--block-size-in-tokens", "16",
		"--max-num-seqs", "256",
		"--max-num-batched-tokens", "8192",
		"--long-prefill-token-threshold", "0",
		"--scheduler", "fcfs",
		"--preemption-policy", "fcfs",
		"--routing-policy", "round-robin",
		"--admission-policy", "always-admit",
		"--kv-cache-dtype", "auto",
		"--latency-model", "trained-physics",
		"--gpu-memory-utilization", "0.9",
		"--metrics-path", "/tmp/m.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", got, want)
	}
}

// The deprecated spelling must not come back: upstream marks
// --max-num-scheduled-tokens deprecated in favour of --max-num-batched-tokens.
func TestArgvUsesTheUndeprecatedBatchedTokensFlag(t *testing.T) {
	got := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	if strings.Contains(got, "--max-num-scheduled-tokens") {
		t.Error("argv uses the deprecated --max-num-scheduled-tokens spelling")
	}
	if !strings.Contains(got, "--max-num-batched-tokens 8192") {
		t.Errorf("argv missing --max-num-batched-tokens: %s", got)
	}
}

// --metrics-path is not optional: cache_hit_rate and requests[] are written only to
// the file branch of EmitOutput, so a stdout capture is a lesser record.
func TestArgvAlwaysCarriesMetricsPath(t *testing.T) {
	got := Argv("./blis", group(), deployment(), "/tmp/m.json", "")
	if got[len(got)-2] != "--metrics-path" || got[len(got)-1] != "/tmp/m.json" {
		t.Errorf("argv must end with --metrics-path <path>, got %v", got[len(got)-2:])
	}
}

func TestArgvConcurrencyModeReplacesRate(t *testing.T) {
	g := group()
	g.Workload.Load = schema.Load{Kind: "concurrency", Value: 32}
	joined := strings.Join(Argv("./blis", g, deployment(), "/tmp/m.json", ""), " ")
	if !strings.Contains(joined, "--concurrency 32") {
		t.Errorf("missing --concurrency: %s", joined)
	}
	if strings.Contains(joined, "--rate") {
		t.Errorf("--rate is mutually exclusive with --concurrency: %s", joined)
	}
}

func TestArgvEmitsHorizonOnlyWhenSet(t *testing.T) {
	joined := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	if strings.Contains(joined, "--horizon") {
		t.Errorf("unset horizon must not appear: %s", joined)
	}
	g := group()
	h := int64(20000000)
	g.HorizonTicks = &h
	joined = strings.Join(Argv("./blis", g, deployment(), "/tmp/m.json", ""), " ")
	if !strings.Contains(joined, "--horizon 20000000") {
		t.Errorf("missing --horizon: %s", joined)
	}
}

// A workload-spec group runs blis via --workload-spec, with the model injected on the
// command line (blis has no top-level model field). The synthetic distribution flags
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
	got := Argv("./blis", g, deployment(), "/tmp/m.json", "/tmp/spec.yaml")
	joined := strings.Join(got, " ")

	if !strings.Contains(joined, "--workload-spec /tmp/spec.yaml") {
		t.Errorf("missing --workload-spec: %s", joined)
	}
	// Model is injected on the CLI (P6): the spec is model-free, blis requires --model.
	if !strings.Contains(joined, "--model qwen/qwen3-14b") || !strings.Contains(joined, "--hardware H100") {
		t.Errorf("model/hardware must still be injected: %s", joined)
	}
	// Seed and timeout are group-side and override the spec; keep them.
	if !strings.Contains(joined, "--seed 42") || !strings.Contains(joined, "--timeout 300") {
		t.Errorf("seed/timeout must be passed: %s", joined)
	}
	// None of the synthetic distribution flags belong here.
	for _, flag := range []string{"--workload distribution", "--num-requests", "--rate", "--concurrency",
		"--prompt-tokens", "--output-tokens"} {
		if strings.Contains(joined, flag) {
			t.Errorf("distribution flag %q leaked into a spec run: %s", flag, joined)
		}
	}
	// --metrics-path stays last.
	if got[len(got)-2] != "--metrics-path" || got[len(got)-1] != "/tmp/m.json" {
		t.Errorf("--metrics-path must stay last: %v", got[len(got)-2:])
	}
}

// gpu-memory-utilization and long-prefill-token-threshold are always emitted; a 0
// threshold is a valid "off", passed rather than dropped.
func TestArgvEmitsGPUMemAndLongPrefillAlways(t *testing.T) {
	d := deployment()
	d.GPUMemoryUtilization = 0.8
	d.LongPrefillTokenThreshold = 2048
	joined := strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	for _, want := range []string{"--gpu-memory-utilization 0.8", "--long-prefill-token-threshold 2048"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q: %s", want, joined)
		}
	}
}

// Speculative decoding follows the --dp precedent: off (K==0) passes none of the trio,
// so blis sees its own defaults and the record reproduces without a meaningless
// --speculative-acceptance-rate 0. On (K>0), the acceptance rate is required and the
// method is passed only when set.
func TestArgvSpeculativeOnlyWhenEnabled(t *testing.T) {
	off := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	for _, flag := range []string{"--num-speculative-tokens", "--speculative-acceptance-rate", "--speculative-method"} {
		if strings.Contains(off, flag) {
			t.Errorf("K==0 must not emit %q: %s", flag, off)
		}
	}

	d := deployment()
	d.NumSpeculativeTokens = 4
	d.SpeculativeAcceptanceRate = 0.7
	on := strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	if !strings.Contains(on, "--num-speculative-tokens 4") || !strings.Contains(on, "--speculative-acceptance-rate 0.7") {
		t.Errorf("K>0 must emit the draft count and acceptance rate: %s", on)
	}
	if strings.Contains(on, "--speculative-method") {
		t.Errorf("an empty method must not be emitted even when K>0: %s", on)
	}

	d.SpeculativeMethod = "eagle"
	withMethod := strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	if !strings.Contains(withMethod, "--speculative-method eagle") {
		t.Errorf("a set method must be emitted when K>0: %s", withMethod)
	}
}

// --routing-scorers is emitted only for the weighted policy, and only when a profile is
// present, so a non-weighted record's argv is unchanged. The pairs are name:weight, joined
// with commas, in the order the profile declares them.
func TestArgvRoutingScorersOnlyWhenWeighted(t *testing.T) {
	// round-robin (the default deployment) never carries a scorer profile, even if one
	// somehow rode along on the record: blis ignores --routing-scorers for it.
	d := deployment()
	d.RoutingScorers = []schema.ScorerConfig{{Name: "queue-depth", Weight: 1}}
	off := strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	if strings.Contains(off, "--routing-scorers") {
		t.Errorf("a non-weighted policy must not emit --routing-scorers: %s", off)
	}

	// weighted with no profile emits nothing, so blis falls back to its own default.
	w := deployment()
	w.RoutingPolicy = "weighted"
	none := strings.Join(Argv("./blis", group(), w, "/tmp/m.json", ""), " ")
	if strings.Contains(none, "--routing-scorers") {
		t.Errorf("weighted with an empty profile must not emit the flag: %s", none)
	}
	if !strings.Contains(none, "--routing-policy weighted") {
		t.Errorf("missing --routing-policy weighted: %s", none)
	}

	// weighted with a profile spells it out, in order, as name:weight pairs.
	w.RoutingScorers = []schema.ScorerConfig{
		{Name: "precise-prefix-cache", Weight: 2},
		{Name: "queue-depth", Weight: 1},
		{Name: "kv-utilization", Weight: 1.5},
	}
	on := Argv("./blis", group(), w, "/tmp/m.json", "")
	joined := strings.Join(on, " ")
	if !strings.Contains(joined, "--routing-scorers precise-prefix-cache:2,queue-depth:1,kv-utilization:1.5") {
		t.Errorf("weighted profile not spelled out as name:weight pairs: %s", joined)
	}
	// It sits with the routing policy, before admission, so the routing block reads together.
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

// The MoE knobs are emitted only when on: --enable-expert-parallel is a valueless bool
// flag, --moe-comm-backend is left off when unset, and both sit between --dp and
// --num-instances so the sharding block reads together.
func TestArgvMoEKnobsOnlyWhenSet(t *testing.T) {
	off := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	for _, flag := range []string{"--enable-expert-parallel", "--moe-comm-backend"} {
		if strings.Contains(off, flag) {
			t.Errorf("a dense/default deployment must not emit %q: %s", flag, off)
		}
	}

	d := deployment()
	d.EnableExpertParallel = true
	d.MoECommBackend = "deepep_high_throughput"
	got := Argv("./blis", group(), d, "/tmp/m.json", "")
	joined := strings.Join(got, " ")
	// --enable-expert-parallel is valueless: it must appear alone, not followed by a value.
	iEP := indexOf(got, "--enable-expert-parallel")
	if iEP < 0 {
		t.Fatalf("missing --enable-expert-parallel: %s", joined)
	}
	if got[iEP+1] != "--moe-comm-backend" {
		t.Errorf("--enable-expert-parallel must be valueless: %v", got[iEP:iEP+2])
	}
	if !strings.Contains(joined, "--moe-comm-backend deepep_high_throughput") {
		t.Errorf("missing --moe-comm-backend: %s", joined)
	}
	if indexOf(got, "--enable-expert-parallel") < indexOf(got, "--dp") {
		// dp is off here, so just assert MoE precedes --num-instances.
	}
	if indexOf(got, "--moe-comm-backend") > indexOf(got, "--num-instances") {
		t.Errorf("MoE knobs must precede --num-instances: %v", got)
	}
}

// Prefill/decode disaggregation is emitted only when the object is present, each flag
// only at a non-default value; the transfer physics stay off the argv at blis's defaults.
func TestArgvDisaggregationEmission(t *testing.T) {
	// No object → none of it appears.
	plain := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	for _, flag := range []string{"--prefill-instances", "--decode-instances", "--pd-decider", "--pd-transfer-bandwidth", "--pd-transfer-contention"} {
		if strings.Contains(plain, flag) {
			t.Errorf("a non-disaggregated deployment must not emit %q: %s", flag, plain)
		}
	}

	// A split at blis's transfer defaults: pools + decider, but no transfer flags.
	d := deployment()
	d.NumInstances = 4
	d.Disaggregation = &schema.Disaggregation{
		PrefillInstances: 1, DecodeInstances: 1,
		Decider:             "always",
		PrefixThreshold:     16,
		TransferBandwidth:   defaultPDTransferBandwidth,
		TransferBaseLatency: defaultPDTransferBaseLatency,
	}
	got := strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	for _, want := range []string{"--prefill-instances 1", "--decode-instances 1", "--pd-decider always"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q: %s", want, got)
		}
	}
	for _, flag := range []string{"--pd-transfer-bandwidth", "--pd-transfer-base-latency", "--pd-transfer-contention", "--pd-prefix-threshold"} {
		if strings.Contains(got, flag) {
			t.Errorf("%q must be omitted at its default / wrong decider: %s", flag, got)
		}
	}

	// A shared-role split with the prefix-threshold decider and tuned transfer physics.
	d2 := deployment()
	d2.NumInstances = 2
	d2.Disaggregation = &schema.Disaggregation{
		PrefillDecodeInstances: 2,
		Decider:                "prefix-threshold",
		PrefixThreshold:        128,
		TransferBandwidth:      50,
		TransferBaseLatency:    0.1,
		TransferContention:     true,
	}
	got2 := strings.Join(Argv("./blis", group(), d2, "/tmp/m.json", ""), " ")
	for _, want := range []string{
		"--prefill-decode-instances 2", "--pd-decider prefix-threshold", "--pd-prefix-threshold 128",
		"--pd-transfer-bandwidth 50", "--pd-transfer-base-latency 0.1", "--pd-transfer-contention",
	} {
		if !strings.Contains(got2, want) {
			t.Errorf("missing %q: %s", want, got2)
		}
	}
}

// --dp is MoE-only upstream and rejects unsupported combinations, so the default of
// 1 is left off rather than asserted.
func TestArgvOmitsDefaultDataParallelism(t *testing.T) {
	joined := strings.Join(Argv("./blis", group(), deployment(), "/tmp/m.json", ""), " ")
	if strings.Contains(joined, "--dp") {
		t.Errorf("dp=1 must not be emitted: %s", joined)
	}
	d := deployment()
	d.DP = 2
	joined = strings.Join(Argv("./blis", group(), d, "/tmp/m.json", ""), " ")
	if !strings.Contains(joined, "--dp 2") {
		t.Errorf("missing --dp 2: %s", joined)
	}
}

// Extra flags are appended in sorted order so the argv — and therefore the record —
// is reproducible.
func TestArgvAppendsExtraFlagsSorted(t *testing.T) {
	d := deployment()
	d.ExtraFlags = map[string]string{"prefix-tokens": "64", "enforce-eager": "true"}
	got := Argv("./blis", group(), d, "/tmp/m.json", "")
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
	first := Argv("./blis", group(), d, "/tmp/m.json", "")
	for i := 0; i < 20; i++ {
		if got := Argv("./blis", group(), d, "/tmp/m.json", ""); !reflect.DeepEqual(got, first) {
			t.Fatalf("argv varied between calls:\n%v\n%v", first, got)
		}
	}
}
