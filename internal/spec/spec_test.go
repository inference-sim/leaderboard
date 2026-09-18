package spec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/hardware"
	"github.com/inference-sim/leaderboard/internal/schema"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "runs.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

const minimal = `
schema_version: 1
group:
  seed: 42
  horizon_ticks: null
  workload:
    type: distribution
    num_requests: 500
    load: {kind: rate, value: 6.0}
    prompt_tokens: 512
    prompt_tokens_stdev: 128
    output_tokens: 128
    output_tokens_stdev: 32
defaults:
  model: qwen/qwen3-14b
  max_num_batched_tokens: 8192
runs:
  - {run_id: h100-tp2, hardware: H100, tp: 2}
  - {run_id: l40s-tp2, hardware: L40S, tp: 2}
`

func TestLoadFillsDefaultsAndDerivedFields(t *testing.T) {
	p, err := Load(write(t, minimal))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// arrival_process is derived from the load kind, never authored: BLIS's rate
	// mode uses a constant arrival process, whatever a human might assume.
	if got := p.Group.Workload.ArrivalProcess; got != "constant" {
		t.Errorf("arrival_process = %q, want %q", got, "constant")
	}
	// --timeout defaults to 300s upstream, and it belongs to the group.
	if got := p.Group.RequestTimeoutS; got != 300 {
		t.Errorf("request_timeout_s = %d, want 300", got)
	}
	if p.Group.HorizonTicks != nil {
		t.Errorf("horizon_ticks = %v, want nil", *p.Group.HorizonTicks)
	}

	if len(p.Runs) != 2 {
		t.Fatalf("got %d candidates, want 2", len(p.Runs))
	}
	d := p.Runs[0].Deployment
	if d.Hardware != "H100" || d.TP != 2 {
		t.Errorf("candidate 0 = %s tp%d", d.Hardware, d.TP)
	}
	// Model is a candidate field now (E1), taken from the declared defaults.
	if d.Model != "qwen/qwen3-14b" {
		t.Errorf("model = %q, want the declared default qwen/qwen3-14b", d.Model)
	}
	if d.MaxNumBatchedTokens != 8192 {
		t.Errorf("max_num_batched_tokens = %d, want the declared default 8192", d.MaxNumBatchedTokens)
	}
	// Unstated deployment fields take BLIS's defaults, and every field is
	// populated so canonicalisation is stable.
	if d.DP != 1 || d.NumInstances != 1 || d.BlockSizeInTokens != 16 ||
		d.MaxNumSeqs != 256 || d.Scheduler != "fcfs" || d.PreemptionPolicy != "fcfs" ||
		d.RoutingPolicy != "round-robin" || d.AdmissionPolicy != "always-admit" ||
		d.KVCacheDtype != "auto" || d.LatencyModel != "trained-physics" {
		t.Errorf("BLIS defaults not filled: %+v", d)
	}
	// The flags added with the model move (§7) take BLIS's defaults too.
	if d.LongPrefillTokenThreshold != 0 || d.GPUMemoryUtilization != 0.9 ||
		d.NumSpeculativeTokens != 0 ||
		d.SpeculativeAcceptanceRate != 0.0 || d.SpeculativeMethod != "" {
		t.Errorf("new-flag defaults not filled: %+v", d)
	}
	if d.ExtraFlags == nil {
		t.Error("extra_flags must be an empty map, not nil, so it marshals as {}")
	}
}

func TestPerRunOverrideDoesNotLeak(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: l40s-tp2, hardware: L40S, tp: 2}",
		"  - {run_id: h100-tp2-seqs8, hardware: H100, tp: 2, max_num_seqs: 8}\n"+
			"  - {run_id: l40s-tp2, hardware: L40S, tp: 2}", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := p.Runs[1].Deployment.MaxNumSeqs; got != 8 {
		t.Errorf("override not applied: max_num_seqs = %d", got)
	}
	if got := p.Runs[2].Deployment.MaxNumSeqs; got != 256 {
		t.Errorf("override leaked into the next candidate: max_num_seqs = %d", got)
	}
}

// A weighted routing profile authored in runs.yaml decodes into RoutingScorers by the
// same JSON round-trip the record is written with, so the CLI and the web form declare
// the same candidate. An unstated profile stays nil (omitted from a non-weighted record).
func TestLoadDecodesRoutingScorers(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: h100-tp2, hardware: H100, tp: 2}",
		"  - {run_id: h100-weighted, hardware: H100, tp: 2, routing_policy: weighted, "+
			"routing_scorers: [{name: precise-prefix-cache, weight: 2}, {name: queue-depth, weight: 1}]}", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	d := p.Runs[0].Deployment
	if d.RoutingPolicy != "weighted" {
		t.Fatalf("routing_policy = %q, want weighted", d.RoutingPolicy)
	}
	if len(d.RoutingScorers) != 2 ||
		d.RoutingScorers[0] != (schema.ScorerConfig{Name: "precise-prefix-cache", Weight: 2}) ||
		d.RoutingScorers[1] != (schema.ScorerConfig{Name: "queue-depth", Weight: 1}) {
		t.Errorf("routing_scorers not decoded: %+v", d.RoutingScorers)
	}
	// The unstated candidate carries no profile, so its record omits the field.
	if got := p.Runs[1].Deployment.RoutingScorers; got != nil {
		t.Errorf("an unstated routing profile must stay nil, got %+v", got)
	}
}

// MoE knobs and a disaggregation block authored in runs.yaml decode through the same JSON
// round-trip the record is written with. An unstated disaggregation stays a nil pointer, so
// a non-disaggregated record omits the block.
func TestLoadDecodesMoEAndDisaggregation(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: h100-tp2, hardware: H100, tp: 2}",
		"  - {run_id: h100-pd, hardware: H100, tp: 2, enable_expert_parallel: true, "+
			"moe_comm_backend: pplx, disaggregation: {prefill_instances: 1, decode_instances: 1, "+
			"prefill_decode_instances: 0, decider: always, prefix_threshold: 16, "+
			"transfer_bandwidth: 25, transfer_base_latency: 0.05, transfer_contention: false}}", 1)
	// The disaggregated candidate needs the pools to fit, so give it more instances.
	body = strings.Replace(body, "tp: 2, enable_expert_parallel", "tp: 2, num_instances: 2, enable_expert_parallel", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	d := p.Runs[0].Deployment
	if !d.EnableExpertParallel || d.MoECommBackend != "pplx" {
		t.Errorf("MoE knobs not decoded: ep=%v backend=%q", d.EnableExpertParallel, d.MoECommBackend)
	}
	if d.Disaggregation == nil {
		t.Fatalf("disaggregation not decoded")
	}
	if d.Disaggregation.PrefillInstances != 1 || d.Disaggregation.DecodeInstances != 1 ||
		d.Disaggregation.Decider != "always" {
		t.Errorf("disaggregation fields wrong: %+v", *d.Disaggregation)
	}
	// The plain candidate declares no MoE and no PD.
	plain := p.Runs[1].Deployment
	if plain.EnableExpertParallel || plain.MoECommBackend != "" || plain.Disaggregation != nil {
		t.Errorf("an unstated candidate must carry no MoE/PD: %+v", plain)
	}
}

func TestLoadRejects(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{
			name:    "unknown deployment field",
			body:    strings.Replace(minimal, "tp: 2}", "tp: 2, max_num_seqz: 8}", 1),
			wantErr: "max_num_seqz",
		},
		{
			name:    "duplicate run_id",
			body:    strings.Replace(minimal, "run_id: l40s-tp2", "run_id: h100-tp2", 1),
			wantErr: "duplicate run_id",
		},
		{
			name:    "missing tp",
			body:    strings.Replace(minimal, "hardware: H100, tp: 2}", "hardware: H100}", 1),
			wantErr: "tp",
		},
		{
			name:    "model without org prefix",
			body:    strings.Replace(minimal, "model: qwen/qwen3-14b", "model: qwen3-14b", 1),
			wantErr: "org-prefixed",
		},
		{
			name:    "model missing entirely",
			body:    strings.Replace(minimal, "  model: qwen/qwen3-14b\n", "", 1),
			wantErr: "org-prefixed",
		},
		{
			name:    "unsupported workload type",
			body:    strings.Replace(minimal, "type: distribution", "type: chatbot", 1),
			wantErr: "distribution",
		},
		{
			name:    "unknown load kind",
			body:    strings.Replace(minimal, "kind: rate", "kind: qps", 1),
			wantErr: "qps",
		},
		{
			name:    "wrong schema version",
			body:    strings.Replace(minimal, "schema_version: 1", "schema_version: 2", 1),
			wantErr: "schema_version",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(write(t, tc.body))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

// A3: two rows that canonicalise identically would differ invisibly, which is the
// one thing the readout must never allow.
func TestCheckRejectsIdenticalDeployments(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: l40s-tp2, hardware: L40S, tp: 2}",
		"  - {run_id: h100-tp2-again, hardware: H100, tp: 2}", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cat, err := hardware.Load(filepath.Join("..", "hardware", "testdata", "hardware_config.json"))
	if err != nil {
		t.Fatalf("hardware.Load: %v", err)
	}
	err = Check(p, cat)
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"h100-tp2", "h100-tp2-again", "identical"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %v, want it to mention %q", err, want)
		}
	}
}

// A table now spans models (E1): two candidates that differ only in model are two
// distinct deployments, so Check accepts them rather than flagging a duplicate.
func TestCheckAcceptsTwoModelsInOneTable(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: l40s-tp2, hardware: L40S, tp: 2}",
		"  - {run_id: h100-tp2-glm, hardware: H100, tp: 2, model: zai-org/glm-5.2-fp8}", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cat, err := hardware.Load(filepath.Join("..", "hardware", "testdata", "hardware_config.json"))
	if err != nil {
		t.Fatalf("hardware.Load: %v", err)
	}
	if err := Check(p, cat); err != nil {
		t.Fatalf("two models on the same hardware and config must be accepted: %v", err)
	}
	if p.Runs[0].Deployment.Model == p.Runs[1].Deployment.Model {
		t.Errorf("expected two different models, got %q twice", p.Runs[0].Deployment.Model)
	}
}

func TestCheckRejectsUnknownHardware(t *testing.T) {
	body := strings.Replace(minimal, "hardware: L40S", "hardware: H200", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cat, err := hardware.Load(filepath.Join("..", "hardware", "testdata", "hardware_config.json"))
	if err != nil {
		t.Fatalf("hardware.Load: %v", err)
	}
	err = Check(p, cat)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "H200") || !strings.Contains(err.Error(), "H100") {
		t.Errorf("error should name the bad value and the valid ones, got %v", err)
	}
}

// Two candidates on hardware that is the same accelerator under two names produce a
// duplicate row, so Check refuses them.
func TestCheckRejectsAliasedHardwarePair(t *testing.T) {
	body := strings.Replace(minimal,
		"  - {run_id: l40s-tp2, hardware: L40S, tp: 2}",
		"  - {run_id: a100-sxm-tp2, hardware: A100-SXM, tp: 2}\n"+
			"  - {run_id: a100-80-tp2, hardware: A100-80, tp: 2}", 1)
	p, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cat, err := hardware.Load(filepath.Join("..", "hardware", "testdata", "hardware_config.json"))
	if err != nil {
		t.Fatalf("hardware.Load: %v", err)
	}
	err = Check(p, cat)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "A100-80") || !strings.Contains(err.Error(), "alias") {
		t.Errorf("error should explain the alias, got %v", err)
	}
}
