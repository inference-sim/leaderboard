package catalog

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func traceProfile(name, sha string) Profile {
	return Profile{
		Name:            name,
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type:      "trace",
			Trace:     &schema.Trace{SHA256: sha, SessionMode: "closed-loop", ConcurrentSessions: 32},
			TraceMeta: &schema.TraceMeta{SourceFormat: "weka", Records: 128000, Sessions: 4000, SessionContextGrowth: "accumulate"},
		},
	}
}

// A trace profile written to workloads.yaml reads back with its comparability knobs and
// display/provenance intact.
func TestCatalogTraceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workloads.yaml")
	c := &Catalog{Profiles: []Profile{traceProfile("acme-jan", "a1b2")}}
	if err := c.Write(path); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got.Profiles) != 1 {
		t.Fatalf("want 1 profile, got %d", len(got.Profiles))
	}
	p := got.Profiles[0]
	if p.Workload.Type != "trace" || p.Workload.Trace == nil || p.Workload.Trace.SHA256 != "a1b2" {
		t.Errorf("trace comparability lost: %+v", p.Workload.Trace)
	}
	if p.Workload.Trace.SessionMode != "closed-loop" || p.Workload.Trace.ConcurrentSessions != 32 {
		t.Errorf("trace knobs lost: %+v", p.Workload.Trace)
	}
	if p.Workload.TraceMeta == nil || p.Workload.TraceMeta.SourceFormat != "weka" || p.Workload.TraceMeta.Records != 128000 {
		t.Errorf("trace_meta lost: %+v", p.Workload.TraceMeta)
	}
}

// The group a trace profile resolves to folds in the trace and derives a sessions load
// for a pool (recorded otherwise), so a table is one trace at one replay configuration.
func TestCatalogTraceGroupDerivesLoad(t *testing.T) {
	pool := traceProfile("pool", "a1b2").Group()
	if pool.Workload.Trace == nil || pool.Workload.Trace.SHA256 != "a1b2" {
		t.Fatalf("group did not carry the trace: %+v", pool.Workload)
	}
	if pool.Workload.Load.Kind != "sessions" || pool.Workload.Load.Value != 32 {
		t.Errorf("pool load = %+v, want sessions/32", pool.Workload.Load)
	}
	rec := traceProfile("rec", "a1b2")
	rec.Workload.Trace.ConcurrentSessions = 0
	rec.Workload.Trace.SessionMode = "fixed"
	rec.Workload.TraceMeta.SessionContextGrowth = ""
	if g := rec.Group(); g.Workload.Load.Kind != "recorded" {
		t.Errorf("non-pool load = %+v, want recorded", g.Workload.Load)
	}
}

// A trace profile with a session mode its corpus forbids is rejected by Validate, which
// defers to schema.ValidateTrace.
func TestCatalogTraceValidateGuards(t *testing.T) {
	p := traceProfile("bad", "a1b2")
	p.Workload.Trace.SessionMode = "fixed" // accumulate corpus forbids fixed
	if err := Validate(p); err == nil {
		t.Fatal("expected Validate to reject a fixed replay of an accumulate corpus")
	} else if !strings.Contains(err.Error(), "accumulate") {
		t.Errorf("error should name the accumulate conflict, got %v", err)
	}
}

// Two trace profiles with identical content under different names are twins (P3); a
// different trace hash is not.
func TestCatalogTraceTwin(t *testing.T) {
	c := &Catalog{Profiles: []Profile{traceProfile("first", "a1b2")}}
	if twin, ok := c.FindContentTwin(traceProfile("second", "a1b2")); !ok || twin != "first" {
		t.Errorf("expected twin of first, got (%q, %v)", twin, ok)
	}
	if _, ok := c.FindContentTwin(traceProfile("third", "cafe")); ok {
		t.Error("a different trace hash should not twin")
	}
}
