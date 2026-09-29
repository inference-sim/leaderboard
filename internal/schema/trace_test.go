package schema

import (
	"strings"
	"testing"
)

// traceFixtureGroup is a comparability group whose workload is a replayed trace.
func traceFixtureGroup() Group {
	return Group{
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type: "trace",
			Load: Load{Kind: "sessions", Value: 32},
			Trace: &Trace{
				SHA256:             "3f9a" + strings.Repeat("0", 60),
				SessionMode:        "closed-loop",
				ConcurrentSessions: 32,
			},
		},
	}
}

// A trace declares no single scalar count (closed-loop generates follow-ups; a pool
// duplicates the corpus), so the injection-short check must be told to stand down
// rather than compare the injected count against zero.
func TestDeclaredRequestsTrace(t *testing.T) {
	w := traceFixtureGroup().Workload
	if n, ok := w.DeclaredRequests(); ok {
		t.Fatalf("DeclaredRequests() = (%d, true), want (_, false) for a trace", n)
	}
}

// The trace's content hash and every injection knob is part of the comparability key:
// the same trace replayed two ways is two tables.
func TestTraceGroupIDKnobSensitive(t *testing.T) {
	base, err := GroupID(traceFixtureGroup())
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	// Stable across calls.
	again, _ := GroupID(traceFixtureGroup())
	if base != again {
		t.Fatalf("GroupID not stable: %q != %q", base, again)
	}
	cases := map[string]func(*Trace){
		"sha256":              func(tr *Trace) { tr.SHA256 = "beef" + strings.Repeat("0", 60) },
		"session_mode":        func(tr *Trace) { tr.SessionMode = "fixed" },
		"concurrent_sessions": func(tr *Trace) { tr.ConcurrentSessions = 16 },
		"total_sessions":      func(tr *Trace) { tr.TotalSessions = 100 },
		"shuffle_corpus":      func(tr *Trace) { tr.ShuffleCorpus = true },
		"think_time_ms":       func(tr *Trace) { tr.ThinkTimeMs = 500 },
		"think_time_dist":     func(tr *Trace) { tr.ThinkTimeDist = "constant:value=500ms" },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			g := traceFixtureGroup()
			mut(g.Workload.Trace)
			id, err := GroupID(g)
			if err != nil {
				t.Fatalf("GroupID: %v", err)
			}
			if id == base {
				t.Errorf("changing %s did not change group_id (%q)", name, id)
			}
		})
	}
}

// The display/provenance of a trace lives on the Record, not in the hashed Group, so
// renaming a trace or recording its row count never moves its runs to a new table.
func TestTraceMetaOutsideGroup(t *testing.T) {
	canon, err := CanonicalJSON(traceFixtureGroup())
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	// Match object keys ("key":), not substrings: Load.Kind "sessions" is a legitimate
	// value that must not trip the display-field check for a "sessions":<n> key.
	for _, forbidden := range []string{`"source_format":`, `"records":`, `"sessions":`, `"session_context_growth":`} {
		if strings.Contains(string(canon), forbidden) {
			t.Errorf("group canonical form carries display field key %s; it must live on the Record", forbidden)
		}
	}
	// TraceMeta is a Record field, and Record is not what GroupID hashes.
	_ = Record{TraceMeta: &TraceMeta{SourceFormat: "weka", Records: 128000, Sessions: 4000, SessionContextGrowth: "accumulate"}}
}

// A distribution group's canonical form (and therefore every committed group_id) is
// unchanged by the new omitempty Trace pointer: a nil Trace is dropped entirely.
func TestNilTraceDropsFromCanonicalForm(t *testing.T) {
	canon, err := CanonicalJSON(fixtureGroup())
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if strings.Contains(string(canon), "trace") {
		t.Errorf("a distribution group's canonical form gained a trace key: %s", canon)
	}
}
