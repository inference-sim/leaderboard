package schema

import "testing"

// fixtureGroup is the twelve-run matrix's comparability group, as it stands after
// the Task 2 fixture migration (arrival_process replaces distribution, and
// request_timeout_s is present).
func fixtureGroup() Group {
	return Group{
		Seed:            42,
		HorizonTicks:    nil,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type:              "distribution",
			ArrivalProcess:    "constant",
			NumRequests:       500,
			Load:              Load{Kind: "rate", Value: 6.0},
			PromptTokens:      512,
			PromptTokensStdev: 256,
			OutputTokens:      128,
			OutputTokensStdev: 256,
		},
	}
}

func TestCanonicalJSONSortsKeysAndDropsWhitespace(t *testing.T) {
	got, err := CanonicalJSON(fixtureGroup())
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `{"horizon_ticks":null,"request_timeout_s":300,` +
		`"seed":42,"workload":{"arrival_process":"constant",` +
		`"load":{"kind":"rate","value":6},"num_requests":500,"output_tokens":128,` +
		`"output_tokens_stdev":256,"prompt_tokens":512,"prompt_tokens_stdev":256,` +
		`"spec_file":null,"spec_sha256":null,"type":"distribution"}}`
	if string(got) != want {
		t.Errorf("canonical form drifted\n got: %s\nwant: %s", got, want)
	}
}

func TestGroupIDIsStable(t *testing.T) {
	id, err := GroupID(fixtureGroup())
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	if id != "5063e40dceb2" {
		t.Errorf("GroupID = %q, want %q — if this changed on purpose, update "+
			"prototypes/results.json and results/ to match", id, "5063e40dceb2")
	}
}

func TestWorkIDIgnoresSeed(t *testing.T) {
	g := fixtureGroup()
	id, err := WorkID(g)
	if err != nil {
		t.Fatalf("WorkID: %v", err)
	}
	if id != "ef152f7b4fe5" {
		t.Errorf("WorkID = %q, want %q", id, "ef152f7b4fe5")
	}

	g.Seed = 1234
	other, err := WorkID(g)
	if err != nil {
		t.Fatalf("WorkID: %v", err)
	}
	if other != id {
		t.Errorf("WorkID changed with the seed: %q != %q", other, id)
	}
	gid1, _ := GroupID(fixtureGroup())
	gid2, _ := GroupID(g)
	if gid1 == gid2 {
		t.Error("GroupID ignored the seed; the seed must bound a table (A2)")
	}
}

func TestHorizonChangesTheGroup(t *testing.T) {
	g := fixtureGroup()
	h := int64(20000000)
	g.HorizonTicks = &h

	id, err := GroupID(g)
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	if id != "6beca76a8f45" {
		t.Errorf("horizon group_id = %q, want %q", id, "6beca76a8f45")
	}
	base, _ := GroupID(fixtureGroup())
	if id == base {
		t.Error("a bounded observation window must make a different group (A4)")
	}
}

// specGroup is a spec-backed comparability group: no distribution fields, an inline
// blis WorkloadSpec, and its content hash. aggregate_rate varies so a test can prove
// the spec content reaches group_id.
func specGroup(aggregateRate float64) Group {
	spec := map[string]any{"version": "2", "aggregate_rate": aggregateRate}
	sha, _ := SpecSHA256(spec)
	return Group{
		Seed:            42,
		HorizonTicks:    nil,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type:       "workload-spec",
			SpecSHA256: &sha,
			Spec:       spec,
		},
	}
}

func TestSpecSHA256IsStableAndOrderIndependent(t *testing.T) {
	a, err := SpecSHA256(map[string]any{"version": "2", "aggregate_rate": 20})
	if err != nil {
		t.Fatalf("SpecSHA256: %v", err)
	}
	b, err := SpecSHA256(map[string]any{"aggregate_rate": 20, "version": "2"})
	if err != nil {
		t.Fatalf("SpecSHA256: %v", err)
	}
	if a != b {
		t.Errorf("spec_sha256 depends on key order: %q != %q", a, b)
	}
	// The stored spec_sha256 is the full digest, not the 12-char group id: a collision
	// here would silently merge two different workloads into one table.
	if len(a) != 64 {
		t.Errorf("spec_sha256 = %q (%d chars), want 64 hex characters", a, len(a))
	}
}

// TestWorkloadSpecFoldsSpecIntoGroupID is the §4 guarantee: identical spec content →
// identical group; different content → different group; and a spec-backed group never
// collides with a flat distribution group.
func TestWorkloadSpecFoldsSpecIntoGroupID(t *testing.T) {
	id, err := GroupID(specGroup(20))
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	again, err := GroupID(specGroup(20))
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	if id != again {
		t.Errorf("group_id is not stable for identical spec content: %q != %q", id, again)
	}
	if other, _ := GroupID(specGroup(40)); other == id {
		t.Error("changing the inline spec content did not change group_id")
	}
	if dist, _ := GroupID(fixtureGroup()); dist == id {
		t.Error("a spec-backed group collided with a distribution group_id")
	}
}

func TestCanonicalJSONIsIndependentOfFieldOrder(t *testing.T) {
	a, err := CanonicalJSON(map[string]any{"b": 2, "a": 1})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	b, err := CanonicalJSON(map[string]any{"a": 1, "b": 2})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if string(a) != string(b) || string(a) != `{"a":1,"b":2}` {
		t.Errorf("got %s and %s", a, b)
	}
}
