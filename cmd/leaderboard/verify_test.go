package main

import (
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func metrics() schema.Metrics {
	return schema.Metrics{
		InstanceID: "cluster", CompletedRequests: 500, InjectedRequests: 500,
		TokensPerSec: 1078.9, E2EP99Ms: 5265.8, TTFTP99Ms: 31.4,
	}
}

func TestDiffMetricsFindsNothingWhenIdentical(t *testing.T) {
	if got := diffMetrics(metrics(), metrics()); len(got) != 0 {
		t.Errorf("diff = %v, want none", got)
	}
}

func TestDiffMetricsNamesEveryChangedField(t *testing.T) {
	b := metrics()
	b.E2EP99Ms = 5265.9
	b.CompletedRequests = 499

	got := diffMetrics(metrics(), b)
	if len(got) != 2 {
		t.Fatalf("diff = %v, want two entries", got)
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{"completed_requests", "499", "e2e_p99_ms", "5265.9"} {
		if !strings.Contains(joined, want) {
			t.Errorf("diff should mention %q, got:\n%s", want, joined)
		}
	}
}
