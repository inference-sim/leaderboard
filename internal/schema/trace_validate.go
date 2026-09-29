package schema

import (
	"fmt"
	"slices"
)

// TraceSessionModes is the closed set of --session-mode values blis replay accepts.
var TraceSessionModes = []string{"fixed", "closed-loop", "fixed-accumulate"}

// ValidateTrace returns every reason a trace workload is not runnable, mirroring the
// cross-flag guards `blis replay` enforces (../inference-sim/cmd/replay.go) so a bad
// declaration is refused at declaration time rather than after a failed subprocess.
// growth is the trace header's session_context_growth ("accumulate" or ""), captured at
// ingest, so these checks run without re-reading the CSV. An empty slice means runnable.
//
// One rule is stricter than blis on purpose: blis auto-promotes --session-mode fixed to
// closed-loop when --concurrent-sessions is set, which would make a stored profile's
// mode disagree with how it actually ran. A pool replay must therefore declare
// closed-loop explicitly here, so the record is honest about what it did.
func ValidateTrace(t Trace, growth string) []string {
	var issues []string
	add := func(format string, args ...any) { issues = append(issues, fmt.Sprintf(format, args...)) }

	if t.SHA256 == "" {
		add("this trace references no content (sha256 is empty); ingest a trace first")
	}

	if !slices.Contains(TraceSessionModes, t.SessionMode) {
		add("session_mode %q is not one of fixed, closed-loop, fixed-accumulate", t.SessionMode)
		// Every remaining guard reasons about the mode; a nonsense mode would make them
		// noise, so stop here with the one actionable error.
		return issues
	}

	if t.ThinkTimeMs < 0 {
		add("think_time_ms must be >= 0, got %d", t.ThinkTimeMs)
	}
	if t.ThinkTimeMs > 0 && t.ThinkTimeDist != "" {
		add("think_time_ms and think_time_dist are mutually exclusive; set at most one")
	}
	if (t.ThinkTimeMs > 0 || t.ThinkTimeDist != "") && t.SessionMode != "closed-loop" {
		add("a think-time override requires session_mode closed-loop, not %q", t.SessionMode)
	}

	if t.ConcurrentSessions < 0 {
		add("concurrent_sessions must be >= 0, got %d", t.ConcurrentSessions)
	}
	if t.ConcurrentSessions > 0 {
		if t.SessionMode == "fixed-accumulate" {
			add("concurrent_sessions is incompatible with session_mode fixed-accumulate " +
				"(a pool is closed-loop); use closed-loop for a pooled replay")
		} else if t.SessionMode != "closed-loop" {
			add("a session pool (concurrent_sessions > 0) requires session_mode closed-loop, not %q", t.SessionMode)
		}
	}
	if t.TotalSessions > 0 && t.ConcurrentSessions == 0 {
		add("total_sessions requires concurrent_sessions > 0")
	}
	if t.ShuffleCorpus && t.ConcurrentSessions == 0 {
		add("shuffle_corpus requires concurrent_sessions > 0 (it randomizes a pool's step order)")
	}

	// An accumulate corpus stores per-round inputs as deltas that only reconstruct in
	// closed-loop or fixed-accumulate replay; fixed mode would misread them.
	if growth == "accumulate" && t.SessionMode != "closed-loop" && t.SessionMode != "fixed-accumulate" {
		add("this trace's session_context_growth is accumulate, which requires session_mode "+
			"closed-loop or fixed-accumulate, not %q", t.SessionMode)
	}
	// fixed-accumulate walks a delta law that is inert on a non-accumulate corpus.
	if t.SessionMode == "fixed-accumulate" && growth != "accumulate" {
		add("session_mode fixed-accumulate requires an accumulate corpus (session_context_growth " +
			"= accumulate); use fixed for a trace with absolute per-round inputs")
	}

	return issues
}
