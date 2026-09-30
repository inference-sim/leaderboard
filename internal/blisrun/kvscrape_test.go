package blisrun

import "testing"

// A realistic capture of what BLIS prints to stdout: the aggregate metrics JSON is
// echoed there too, followed by the human-readable KV Cache Metrics section that
// printKVCacheMetrics emits (upstream cmd/root.go) with three %.4f lines.
const kvSection = `{"instance_id":"cluster","completed_requests":500}
=== KV Cache Metrics ===
Preemption Rate: 0.0120
Cache Hit Rate: 0.4200
KV Thrashing Rate: 0.0345
`

func TestParseKVThrashingReadsTheValue(t *testing.T) {
	got := parseKVThrashing(kvSection)
	if got == nil {
		t.Fatal("KV Thrashing Rate line present but parseKVThrashing returned nil")
	}
	if *got != 0.0345 {
		t.Errorf("kv thrashing = %v, want 0.0345", *got)
	}
}

// BLIS omits the whole KV Cache Metrics section when preemption, cache-hit, and
// thrashing rates are all zero, so a run's stdout may carry no thrashing line at all.
// That is "not reported", nil, not zero.
func TestParseKVThrashingAbsentSectionIsNil(t *testing.T) {
	if got := parseKVThrashing(`{"instance_id":"cluster","completed_requests":500}`); got != nil {
		t.Errorf("no KV section but got %v, want nil", *got)
	}
}

// A malformed value must not panic and must not be read as a spurious zero: return nil
// so the column shows "—" rather than a wrong number.
func TestParseKVThrashingMalformedLineIsNil(t *testing.T) {
	malformed := "=== KV Cache Metrics ===\nKV Thrashing Rate: not-a-number\n"
	if got := parseKVThrashing(malformed); got != nil {
		t.Errorf("malformed line but got %v, want nil", *got)
	}
}

// A zero thrashing rate is a real reported value (the section is printed because some
// other rate was nonzero), distinct from the section being absent.
func TestParseKVThrashingZeroIsReported(t *testing.T) {
	zero := "=== KV Cache Metrics ===\nPreemption Rate: 0.0120\nCache Hit Rate: 0.4200\nKV Thrashing Rate: 0.0000\n"
	got := parseKVThrashing(zero)
	if got == nil {
		t.Fatal("a printed KV Thrashing Rate of 0 must be reported, not nil")
	}
	if *got != 0 {
		t.Errorf("kv thrashing = %v, want 0", *got)
	}
}
