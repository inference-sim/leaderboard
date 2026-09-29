package schema

import (
	"strings"
	"testing"
)

// A well-formed pool replay of an accumulate corpus is runnable.
func TestValidateTraceOK(t *testing.T) {
	tr := Trace{SHA256: "abc", SessionMode: "closed-loop", ConcurrentSessions: 32}
	if issues := ValidateTrace(tr, "accumulate"); len(issues) != 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}
}

// A plain fixed replay of a non-session trace is runnable.
func TestValidateTraceFixedOK(t *testing.T) {
	tr := Trace{SHA256: "abc", SessionMode: "fixed"}
	if issues := ValidateTrace(tr, ""); len(issues) != 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}
}

// Each guard mirrors a fatal in blis replay: a bad declaration must be refused before
// we shell out. The substring is the actionable phrase the issue must name.
func TestValidateTraceGuards(t *testing.T) {
	cases := []struct {
		name   string
		trace  Trace
		growth string
		want   string
	}{
		{"missing sha", Trace{SessionMode: "fixed"}, "", "trace"},
		{"bad mode", Trace{SHA256: "a", SessionMode: "loop"}, "", "session_mode"},
		{"think ms needs closed-loop", Trace{SHA256: "a", SessionMode: "fixed", ThinkTimeMs: 500}, "", "closed-loop"},
		{"think dist needs closed-loop", Trace{SHA256: "a", SessionMode: "fixed", ThinkTimeDist: "constant:value=1s"}, "", "closed-loop"},
		{"think ms and dist exclusive", Trace{SHA256: "a", SessionMode: "closed-loop", ThinkTimeMs: 500, ThinkTimeDist: "constant:value=1s"}, "", "mutually exclusive"},
		{"negative think ms", Trace{SHA256: "a", SessionMode: "closed-loop", ThinkTimeMs: -1}, "", "think_time_ms"},
		{"pool needs closed-loop", Trace{SHA256: "a", SessionMode: "fixed", ConcurrentSessions: 8}, "", "closed-loop"},
		{"pool incompatible with fixed-accumulate", Trace{SHA256: "a", SessionMode: "fixed-accumulate", ConcurrentSessions: 8}, "accumulate", "concurrent_sessions"},
		{"total needs pool", Trace{SHA256: "a", SessionMode: "closed-loop", TotalSessions: 100}, "", "concurrent_sessions"},
		{"shuffle needs pool", Trace{SHA256: "a", SessionMode: "closed-loop", ShuffleCorpus: true}, "", "concurrent_sessions"},
		{"accumulate needs closed-loop or fixed-accumulate", Trace{SHA256: "a", SessionMode: "fixed"}, "accumulate", "accumulate"},
		{"fixed-accumulate needs accumulate corpus", Trace{SHA256: "a", SessionMode: "fixed-accumulate"}, "", "accumulate"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := ValidateTrace(c.trace, c.growth)
			if len(issues) == 0 {
				t.Fatalf("expected an issue naming %q, got none", c.want)
			}
			joined := strings.Join(issues, " | ")
			if !strings.Contains(joined, c.want) {
				t.Errorf("issue %q does not name %q", joined, c.want)
			}
		})
	}
}

// closed-loop replay of an accumulate corpus, and fixed-accumulate of one, are both
// valid ways to reconstruct the growing prompt.
func TestValidateTraceAccumulateModes(t *testing.T) {
	for _, mode := range []string{"closed-loop", "fixed-accumulate"} {
		tr := Trace{SHA256: "a", SessionMode: mode}
		if issues := ValidateTrace(tr, "accumulate"); len(issues) != 0 {
			t.Errorf("mode %q on accumulate corpus should be valid, got %v", mode, issues)
		}
	}
}
