package blisrun

import (
	"reflect"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func traceGroup() schema.Group {
	return schema.Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type: "trace",
			Load: schema.Load{Kind: "sessions", Value: 32},
			Trace: &schema.Trace{
				SHA256:             "3f9a",
				SessionMode:        "closed-loop",
				ConcurrentSessions: 32,
			},
		},
	}
}

func TestReplayArgvStructure(t *testing.T) {
	got := ReplayArgv("./blis", traceGroup(), deployment(), "/tmp/m.json", "/store/3f9a/header.yaml", "/store/3f9a/data.csv")
	want := []string{
		"./blis", "replay",
		"--trace-header", "/store/3f9a/header.yaml",
		"--trace-data", "/store/3f9a/data.csv",
		"--session-mode", "closed-loop",
		"--concurrent-sessions", "32",
		"--model", "qwen/qwen3-14b",
		"--hardware", "H100",
		"--tp", "2",
		"--num-instances", "1",
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
		"--seed", "42",
		"--metrics-path", "/tmp/m.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("replay argv drifted\n got: %v\nwant: %v", got, want)
	}
}

// blis replay does not register --timeout (it is run-only; a per-request deadline comes
// from the trace, not a CLI flag). Emitting it makes cobra reject the whole command with
// a usage dump, so ReplayArgv must never include it.
func TestReplayArgvOmitsTimeout(t *testing.T) {
	joined := strings.Join(ReplayArgv("./blis", traceGroup(), deployment(), "/tmp/m.json", "h", "d"), " ")
	if strings.Contains(joined, "--timeout") {
		t.Errorf("replay argv emitted --timeout, which blis replay does not accept: %s", joined)
	}
}

// The synthetic-distribution flags are never emitted for a replay: the request stream is
// the trace, and blis replay does not register --workload/--num-requests/--rate/--prompt-tokens.
func TestReplayArgvOmitsSyntheticFlags(t *testing.T) {
	joined := strings.Join(ReplayArgv("./blis", traceGroup(), deployment(), "/tmp/m.json", "h", "d"), " ")
	for _, forbidden := range []string{"--workload ", "--num-requests", "--rate", "--concurrency", "--prompt-tokens", "--output-tokens"} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("replay argv emitted synthetic flag %q: %s", forbidden, joined)
		}
	}
}

func TestReplayArgvThinkTimeAndPoolKnobs(t *testing.T) {
	g := traceGroup()
	g.Workload.Trace.TotalSessions = 100
	g.Workload.Trace.ShuffleCorpus = true
	g.Workload.Trace.ThinkTimeDist = "constant:value=500ms"
	joined := strings.Join(ReplayArgv("./blis", g, deployment(), "/tmp/m.json", "h", "d"), " ")
	for _, want := range []string{
		"--total-sessions 100", "--shuffle-corpus", "--think-time-dist constant:value=500ms",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("replay argv missing %q: %s", want, joined)
		}
	}
}

func TestReplayArgvThinkTimeMs(t *testing.T) {
	g := traceGroup()
	g.Workload.Trace.ConcurrentSessions = 0
	g.Workload.Trace.ThinkTimeMs = 500
	joined := strings.Join(ReplayArgv("./blis", g, deployment(), "/tmp/m.json", "h", "d"), " ")
	if !strings.Contains(joined, "--think-time-ms 500") {
		t.Errorf("replay argv missing --think-time-ms 500: %s", joined)
	}
	if strings.Contains(joined, "--concurrent-sessions") {
		t.Errorf("replay argv emitted --concurrent-sessions with a zero pool: %s", joined)
	}
}

func TestReplayArgvHorizon(t *testing.T) {
	g := traceGroup()
	h := int64(2_000_000)
	g.HorizonTicks = &h
	joined := strings.Join(ReplayArgv("./blis", g, deployment(), "/tmp/m.json", "h", "d"), " ")
	if !strings.Contains(joined, "--horizon 2000000") {
		t.Errorf("replay argv missing --horizon: %s", joined)
	}
}

// The candidate is described identically to a `run`: the deployment-flag subsequence a
// replay emits must equal the one `run` emits for the same deployment, so the two
// commands cannot drift in how a candidate is spelled.
func TestReplayArgvSharesDeploymentBlock(t *testing.T) {
	d := deployment()
	runArgv := Argv("./blis", group(), d, "/tmp/m.json", "")
	replayArgv := ReplayArgv("./blis", traceGroup(), d, "/tmp/m.json", "h", "d")
	if runDep, replayDep := deploymentFlagsOf(runArgv), deploymentFlagsOf(replayArgv); !reflect.DeepEqual(runDep, replayDep) {
		t.Errorf("deployment flags differ between run and replay\n run: %v\n rep: %v", runDep, replayDep)
	}
}

// deploymentFlagsOf extracts the model/hardware/scheduler/... candidate flags shared by
// run and replay, dropping the workload, group, and trace flags that legitimately differ.
func deploymentFlagsOf(argv []string) []string {
	skip := map[string]bool{
		"--workload": true, "--num-requests": true, "--rate": true, "--concurrency": true,
		"--prompt-tokens": true, "--prompt-tokens-stdev": true, "--output-tokens": true, "--output-tokens-stdev": true,
		"--workload-spec": true, "--trace-header": true, "--trace-data": true, "--session-mode": true,
		"--concurrent-sessions": true, "--total-sessions": true, "--think-time-ms": true, "--think-time-dist": true,
		"--seed": true, "--timeout": true, "--horizon": true, "--metrics-path": true,
	}
	var out []string
	for i := 2; i < len(argv); i++ { // skip binary + subcommand
		a := argv[i]
		if strings.HasPrefix(a, "--") {
			base := a
			if skip[base] {
				// also skip its value if it takes one
				if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
					i++
				}
				continue
			}
		}
		out = append(out, a)
	}
	return out
}
