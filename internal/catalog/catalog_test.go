package catalog

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func distProfile(name string, rate float64) Profile {
	return Profile{
		Name:            name,
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type:              "distribution",
			NumRequests:       500,
			Load:              schema.Load{Kind: "rate", Value: rate},
			PromptTokens:      512,
			PromptTokensStdev: 256,
			OutputTokens:      128,
			OutputTokensStdev: 256,
		},
	}
}

func specProfile(name string, aggregateRate float64) Profile {
	return Profile{
		Name:            name,
		Seed:            42,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type: "workload-spec",
			Spec: map[string]any{
				"version":        "2",
				"aggregate_rate": aggregateRate,
				"clients": []any{
					map[string]any{
						"id":                  "c1",
						"weight":              1,
						"arrival":             map[string]any{"process": "poisson"},
						"input_distribution":  map[string]any{"type": "lognormal", "params": map[string]any{"mu": 6.0, "sigma": 0.4}},
						"output_distribution": map[string]any{"type": "gaussian", "params": map[string]any{"mean": 128, "std_dev": 64}},
					},
				},
			},
		},
	}
}

func TestReadMissingFileIsEmptyCatalog(t *testing.T) {
	c, err := Read(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(c.Profiles) != 0 {
		t.Fatalf("want empty catalog, got %d profiles", len(c.Profiles))
	}
}

func TestRoundTripDistributionAndSpec(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	orig := &Catalog{Profiles: []Profile{
		distProfile("chat-6rps", 6),
		specProfile("cohort-diurnal", 20),
	}}
	if err := orig.Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got.Profiles) != 2 {
		t.Fatalf("want 2 profiles, got %d", len(got.Profiles))
	}
	if got.Profiles[0].Name != "chat-6rps" || got.Profiles[0].Workload.NumRequests != 500 {
		t.Errorf("distribution profile drifted: %+v", got.Profiles[0])
	}
	spec := got.Profiles[1]
	if spec.Workload.Type != "workload-spec" || spec.Workload.Spec["version"] != "2" {
		t.Errorf("spec profile drifted: %+v", spec.Workload)
	}
}

func TestWriteCreatesParentDirectory(t *testing.T) {
	// The catalog lives at <out>/workloads.yaml, and <out> may not exist yet on a fresh
	// checkout, so Write must create it.
	path := filepath.Join(t.TempDir(), "results", "workloads.yaml")
	c := &Catalog{Profiles: []Profile{distProfile("chat", 6)}}
	if err := c.Write(path); err != nil {
		t.Fatalf("write into a missing directory should create it: %v", err)
	}
	got, err := Read(path)
	if err != nil || len(got.Profiles) != 1 {
		t.Fatalf("round-trip through a created directory failed: %+v (%v)", got, err)
	}
}

func TestReadRejectsDuplicateName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	// Two different-content profiles sharing a name.
	c := &Catalog{Profiles: []Profile{distProfile("chat", 6), distProfile("chat", 10)}}
	if err := c.Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := Read(path)
	if err == nil || !strings.Contains(err.Error(), "chat") {
		t.Fatalf("want duplicate-name rejection naming \"chat\", got %v", err)
	}
}

func TestReadRejectsDuplicateContentWithTwinPointer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	// Same content, two names — the P3 twin rejection.
	c := &Catalog{Profiles: []Profile{distProfile("chat-a", 6), distProfile("chat-b", 6)}}
	if err := c.Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := Read(path)
	if err == nil {
		t.Fatal("want duplicate-content rejection")
	}
	if !strings.Contains(err.Error(), "chat-a") || !strings.Contains(err.Error(), "chat-b") {
		t.Errorf("twin rejection should name both profiles, got %v", err)
	}
}

func TestFindContentTwin(t *testing.T) {
	c := &Catalog{Profiles: []Profile{distProfile("chat-6rps", 6)}}
	// Same content, proposed under a new name.
	twin, ok := c.FindContentTwin(distProfile("something-else", 6))
	if !ok || twin != "chat-6rps" {
		t.Errorf("want twin \"chat-6rps\", got %q (%v)", twin, ok)
	}
	// Different content: no twin.
	if _, ok := c.FindContentTwin(distProfile("faster", 10)); ok {
		t.Error("a different rate must not be reported as a twin")
	}
	// Editing a profile in place (same name, same content) is not its own twin.
	if _, ok := c.FindContentTwin(distProfile("chat-6rps", 6)); ok {
		t.Error("a profile is not a twin of itself")
	}
}

func TestGroupFoldsSpec(t *testing.T) {
	p := specProfile("cohort", 20)
	g := p.Group()
	// Model is no longer part of the group (E1): a profile resolves to a model-free
	// comparability group, and the model is a candidate supplied per row.
	if g.Workload.Type != "workload-spec" || g.Workload.SpecSHA256 == nil {
		t.Fatalf("spec workload not resolved: %+v", g.Workload)
	}
	// group_id folds the spec: a different spec is a different group.
	id, err := schema.GroupID(g)
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	other := specProfile("cohort", 40).Group()
	oid, _ := schema.GroupID(other)
	if id == oid {
		t.Error("changing aggregate_rate did not change group_id")
	}
	// The stored spec_sha256 matches the content hash of the inline spec.
	want, _ := schema.SpecSHA256(p.Workload.Spec)
	if *g.Workload.SpecSHA256 != want {
		t.Errorf("spec_sha256 = %q, want %q", *g.Workload.SpecSHA256, want)
	}
}

func TestValidateRejectsModelPinnedSpec(t *testing.T) {
	cases := map[string]map[string]any{
		"client model":   {"version": "2", "clients": []any{map[string]any{"model": "meta/llama"}}},
		"client adapter": {"version": "2", "clients": []any{map[string]any{"adapter": "lora-1"}}},
		"cohort model":   {"version": "2", "cohorts": []any{map[string]any{"model": "meta/llama"}}},
		"cohort adapter": {"version": "2", "cohorts": []any{map[string]any{"adapter": "lora-1"}}},
	}
	for name, spec := range cases {
		t.Run(name, func(t *testing.T) {
			p := Profile{Name: "pinned", Seed: 1, RequestTimeoutS: 300,
				Workload: Workload{Type: "workload-spec", Spec: spec}}
			err := Validate(p)
			if err == nil || !strings.Contains(err.Error(), "model") && !strings.Contains(err.Error(), "adapter") {
				t.Fatalf("want model/adapter-pinning rejection, got %v", err)
			}
		})
	}
}

func TestValidateRejectsMismatchedVariant(t *testing.T) {
	// A distribution profile carrying a spec.
	bad := distProfile("x", 6)
	bad.Workload.Spec = map[string]any{"version": "2"}
	if err := Validate(bad); err == nil {
		t.Error("a distribution profile with a spec must be rejected")
	}
	// A workload-spec profile with no spec.
	empty := Profile{Name: "y", Seed: 1, RequestTimeoutS: 300, Workload: Workload{Type: "workload-spec"}}
	if err := Validate(empty); err == nil {
		t.Error("a workload-spec profile without a spec must be rejected")
	}
}
