package schema

import (
	"encoding/json"
	"testing"
)

func TestDeclaredRequestsDistribution(t *testing.T) {
	w := Workload{Type: "distribution", NumRequests: 500}
	n, ok := w.DeclaredRequests()
	if !ok || n != 500 {
		t.Fatalf("DeclaredRequests() = (%d, %v), want (500, true)", n, ok)
	}
}

// A spec decoded from JSON carries float64; one built in Go carries int. Both must
// resolve to the same declared count, since the flat NumRequests is a placeholder for
// this variant and reading it would report zero.
func TestDeclaredRequestsSpecNumericForms(t *testing.T) {
	for name, num := range map[string]any{
		"float64":     float64(500),
		"int":         500,
		"int64":       int64(500),
		"json.Number": json.Number("500"),
	} {
		t.Run(name, func(t *testing.T) {
			w := Workload{Type: "workload-spec", NumRequests: 0, Spec: map[string]any{"num_requests": num}}
			n, ok := w.DeclaredRequests()
			if !ok || n != 500 {
				t.Fatalf("DeclaredRequests() = (%d, %v), want (500, true)", n, ok)
			}
		})
	}
}

// A spec that declares no scalar num_requests (a cohort- or trace-driven load) has no
// single declared count, so the check that would otherwise compare against zero is
// told to stand down.
func TestDeclaredRequestsSpecWithoutCount(t *testing.T) {
	w := Workload{Type: "workload-spec", NumRequests: 0, Spec: map[string]any{"aggregate_rate": 10.0}}
	if n, ok := w.DeclaredRequests(); ok {
		t.Fatalf("DeclaredRequests() = (%d, true), want (_, false) for a spec with no num_requests", n)
	}
}
