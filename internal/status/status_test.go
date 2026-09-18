package status

import (
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func group(numRequests int) schema.Group {
	return schema.Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type:           "distribution",
			ArrivalProcess: "constant",
			NumRequests:    numRequests,
			Load:           schema.Load{Kind: "rate", Value: 6.0},
			PromptTokens:   512, OutputTokens: 128,
		},
	}
}

// healthy is the h100-tp2 row of the committed fixture: 500 of 500, nothing shed.
func healthy() schema.Metrics {
	return schema.Metrics{
		InstanceID: "cluster", CompletedRequests: 500, InjectedRequests: 500,
		TotalInputTokens: 248510, TotalOutputTokens: 93040,
		TokensPerSec: 1078.9, ResponsesPerSec: 5.8, E2EP99Ms: 5265.8, TTFTP99Ms: 31.4,
	}
}

func codes(s schema.Status) []string {
	out := make([]string, 0, len(s.Disqualifications))
	for _, d := range s.Disqualifications {
		out = append(out, d.Code)
	}
	return out
}

func TestHealthyRunIsComplete(t *testing.T) {
	got := Evaluate(healthy(), group(500))
	if !got.Complete {
		t.Errorf("complete = false, disqualifications = %v", codes(got))
	}
	if len(got.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", got.Warnings)
	}
}

func TestRules(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*schema.Metrics)
		wantCode   string
		wantClass  string
		wantDetail string
	}{
		{
			// The fixture's max_model_len 640 run: the best tail latency in the
			// file, produced by not doing the work.
			name: "dropped unservable",
			mutate: func(m *schema.Metrics) {
				m.CompletedRequests = 241
				m.DroppedUnservable = 259
				m.E2EP99Ms = 2959.8
				m.TokensPerSec = 269.2
			},
			wantCode: CodeRequestsDropped, wantClass: ClassIncomplete,
			wantDetail: "259 of 500 requests dropped as unservable",
		},
		{
			// Verified reachable: --timeout 3 on L40S tp1 at rate 6.0.
			name: "timed out",
			mutate: func(m *schema.Metrics) {
				m.CompletedRequests = 380
				m.TimedOutRequests = 120
			},
			wantCode: CodeRequestsTimedOut, wantClass: ClassIncomplete,
			wantDetail: "120 of 500 requests timed out before their 300s deadline",
		},
		{
			name: "window ended busy",
			mutate: func(m *schema.Metrics) {
				m.CompletedRequests = 494
				m.StillRunning = 6
			},
			wantCode: CodeWindowEndedBusy, wantClass: ClassIncomplete,
			wantDetail: "0 still queued and 6 still running when the observation window closed",
		},
		{
			name: "injection short",
			mutate: func(m *schema.Metrics) {
				m.CompletedRequests = 119
				m.InjectedRequests = 119
			},
			wantCode: CodeInjectionShort, wantClass: ClassIncomplete,
			wantDetail: "119 of 500 declared requests were offered",
		},
		{
			// A1. Retained because the counter is authoritative if it ever fires,
			// though no `blis run` flag combination is known to reach it (C6).
			name: "output truncated",
			mutate: func(m *schema.Metrics) {
				m.LengthCappedRequests = 12
			},
			wantCode: CodeOutputTruncated, wantClass: ClassAltered,
			wantDetail: "12 requests were force-completed at the max_model_len boundary",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := healthy()
			tc.mutate(&m)
			got := Evaluate(m, group(500))

			if got.Complete {
				t.Error("complete = true, want false")
			}
			var found *schema.Disqualification
			for i := range got.Disqualifications {
				if got.Disqualifications[i].Code == tc.wantCode {
					found = &got.Disqualifications[i]
				}
			}
			if found == nil {
				t.Fatalf("codes = %v, want %s among them", codes(got), tc.wantCode)
			}
			if found.Class != tc.wantClass {
				t.Errorf("class = %q, want %q", found.Class, tc.wantClass)
			}
			if found.Detail != tc.wantDetail {
				t.Errorf("detail = %q\n         want %q", found.Detail, tc.wantDetail)
			}
		})
	}
}

// The fixture's horizon run trips two rules at once, and both must be reported:
// the window closed on six running requests AND only 119 of 500 were ever offered.
func TestTwoRulesCanFireTogether(t *testing.T) {
	m := healthy()
	m.CompletedRequests = 113
	m.StillRunning = 6
	m.InjectedRequests = 119

	got := Evaluate(m, group(500))
	if len(got.Disqualifications) != 2 {
		t.Fatalf("codes = %v, want exactly window_ended_busy and injection_short", codes(got))
	}
	if got.Disqualifications[0].Code != CodeWindowEndedBusy {
		t.Errorf("first code = %q, want %q", got.Disqualifications[0].Code, CodeWindowEndedBusy)
	}
	if got.Disqualifications[1].Code != CodeInjectionShort {
		t.Errorf("second code = %q, want %q", got.Disqualifications[1].Code, CodeInjectionShort)
	}
}

// Preemption is a caveat, not a disqualification: a preempted run still produced
// complete, honest results.
func TestPreemptionWarnsWithoutDisqualifying(t *testing.T) {
	m := healthy()
	m.PreemptionCount = 3

	got := Evaluate(m, group(500))
	if !got.Complete {
		t.Errorf("complete = false, want true (preemption must not disqualify)")
	}
	if len(got.Warnings) != 1 || got.Warnings[0].Code != CodePreemptions {
		t.Fatalf("warnings = %v, want one %s", got.Warnings, CodePreemptions)
	}
	if got.Warnings[0].Detail != "3 preemptions" {
		t.Errorf("detail = %q", got.Warnings[0].Detail)
	}
}

// injected_requests is an identity upstream (sim/metrics.go:102). If it stops
// holding, this repo's model of BLIS is wrong and the record should say so.
func TestAccountingMismatchWarns(t *testing.T) {
	m := healthy()
	m.InjectedRequests = 600 // 500 completed + nothing else pending

	got := Evaluate(m, group(500))
	var found bool
	for _, w := range got.Warnings {
		if w.Code == CodeAccountingMismatch {
			found = true
			if !strings.Contains(w.Detail, "600") || !strings.Contains(w.Detail, "500") {
				t.Errorf("detail should name both totals, got %q", w.Detail)
			}
		}
	}
	if !found {
		t.Errorf("warnings = %v, want %s", got.Warnings, CodeAccountingMismatch)
	}
}

// specGroup is a workload-spec comparability group: the flat NumRequests is the
// placeholder zero this variant carries, and the real declared count lives in the spec.
func specGroup(specNumRequests int) schema.Group {
	spec := map[string]any{"version": "2", "aggregate_rate": 10.0}
	if specNumRequests > 0 {
		spec["num_requests"] = float64(specNumRequests)
	}
	return schema.Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type:           "workload-spec",
			ArrivalProcess: "constant",
			NumRequests:    0,
			Load:           schema.Load{Kind: "rate", Value: 0},
			Spec:           spec,
		},
	}
}

// A spec-backed run that offered its full declared count is complete. Reading the flat
// NumRequests (0) instead of the spec would fire injection_short for every spec run —
// the bug this guards against.
func TestSpecRunIsCompleteWhenFullyInjected(t *testing.T) {
	got := Evaluate(healthy(), specGroup(500))
	if !got.Complete {
		t.Errorf("complete = false, disqualifications = %v; a fully-injected spec run must rank", codes(got))
	}
}

// injection_short still fires for a spec run, counted against the spec's declared total.
func TestSpecRunShortInjectionUsesSpecCount(t *testing.T) {
	m := healthy()
	m.CompletedRequests = 400
	m.InjectedRequests = 400
	got := Evaluate(m, specGroup(500))
	var found *schema.Disqualification
	for i := range got.Disqualifications {
		if got.Disqualifications[i].Code == CodeInjectionShort {
			found = &got.Disqualifications[i]
		}
	}
	if found == nil {
		t.Fatalf("codes = %v, want injection_short", codes(got))
	}
	if found.Detail != "400 of 500 declared requests were offered" {
		t.Errorf("detail = %q", found.Detail)
	}
}

// A spec with no scalar num_requests (cohort- or trace-driven) has no declared count to
// compare against, so injection_short is skipped rather than compared against zero.
func TestSpecRunWithoutCountSkipsInjectionShort(t *testing.T) {
	got := Evaluate(healthy(), specGroup(0))
	for _, c := range codes(got) {
		if c == CodeInjectionShort {
			t.Fatalf("codes = %v, injection_short must not fire without a declared count", codes(got))
		}
	}
}

// Nothing about status may depend on throughput: the fixture's max_num_seqs 8 run
// is within 0.9% of stock on tokens/s while its TTFT p99 is 110x worse, and it is
// legitimately complete.
func TestSlowButCompleteRunIsNotDisqualified(t *testing.T) {
	m := healthy()
	m.TTFTP99Ms = 3471.1
	m.SchedulingDelayP99Ms = 3462.8
	m.TokensPerSec = 1069.2

	got := Evaluate(m, group(500))
	if !got.Complete {
		t.Errorf("a slow run must still be complete; got %v", codes(got))
	}
}
