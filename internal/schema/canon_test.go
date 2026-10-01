package schema

import "testing"

// fixtureGroup is the my-workload2 comparability group — a flat gaussian workload (500
// requests, 6 req/s, 512±256 in / 128±256 out) as it is now stored: lowered to the
// one-client workload-spec blis itself builds from `--workload distribution`. Its
// group_id is the committed results/86575212efc8 table.
func fixtureGroup() Group {
	spec := map[string]any{
		"version":        "2",
		"category":       "language",
		"aggregate_rate": 6.0,
		"num_requests":   500,
		"clients": []any{map[string]any{
			"id":                  "c0",
			"rate_fraction":       1.0,
			"arrival":             map[string]any{"process": "constant"},
			"input_distribution":  map[string]any{"type": "gaussian", "params": map[string]any{"mean": 512.0, "std_dev": 256.0, "min": 2.0, "max": 7000.0}},
			"output_distribution": map[string]any{"type": "gaussian", "params": map[string]any{"mean": 128.0, "std_dev": 256.0, "min": 2.0, "max": 7000.0}},
		}},
	}
	sha, _ := SpecSHA256(spec)
	return Group{
		Seed:            42,
		HorizonTicks:    nil,
		RequestTimeoutS: 300,
		Workload: Workload{
			Type:           "workload-spec",
			ArrivalProcess: "constant",
			Load:           Load{Kind: "rate"},
			SpecSHA256:     &sha,
			Spec:           spec,
		},
	}
}

func TestCanonicalJSONSortsKeysAndDropsWhitespace(t *testing.T) {
	got, err := CanonicalJSON(fixtureGroup())
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `{"horizon_ticks":null,"request_timeout_s":300,"seed":42,"workload":{` +
		`"arrival_process":"constant","load":{"kind":"rate","value":0},"num_requests":0,` +
		`"output_tokens":0,"output_tokens_stdev":0,"prompt_tokens":0,"prompt_tokens_stdev":0,` +
		`"spec":{"aggregate_rate":6,"category":"language","clients":[{"arrival":{"process":"constant"},` +
		`"id":"c0","input_distribution":{"params":{"max":7000,"mean":512,"min":2,"std_dev":256},"type":"gaussian"},` +
		`"output_distribution":{"params":{"max":7000,"mean":128,"min":2,"std_dev":256},"type":"gaussian"},` +
		`"rate_fraction":1}],"num_requests":500,"version":"2"},` +
		`"spec_file":null,"spec_sha256":"7aa7a6b03fe2a4ad54d2c291e750993e02d2e1885a6645fbfb21b3e24c1c1d7e",` +
		`"type":"workload-spec"}}`
	if string(got) != want {
		t.Errorf("canonical form drifted\n got: %s\nwant: %s", got, want)
	}
}

func TestGroupIDIsStable(t *testing.T) {
	id, err := GroupID(fixtureGroup())
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	if id != "86575212efc8" {
		t.Errorf("GroupID = %q, want %q — if this changed on purpose, update "+
			"prototypes/results.json and results/ to match", id, "86575212efc8")
	}
}

func TestWorkIDIgnoresSeed(t *testing.T) {
	g := fixtureGroup()
	id, err := WorkID(g)
	if err != nil {
		t.Fatalf("WorkID: %v", err)
	}
	if id != "f440c288c4fe" {
		t.Errorf("WorkID = %q, want %q", id, "f440c288c4fe")
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
	if id != "e5538d4d5107" {
		t.Errorf("horizon group_id = %q, want %q", id, "e5538d4d5107")
	}
	base, _ := GroupID(fixtureGroup())
	if id == base {
		t.Error("a bounded observation window must make a different group (A4)")
	}
}

// specGroup is a minimal spec-backed comparability group: an inline blis WorkloadSpec
// and its content hash. aggregate_rate varies so a test can prove the spec content
// reaches group_id.
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
// identical group; different content → different group; and two different specs never
// collide on one group_id.
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
	if other, _ := GroupID(fixtureGroup()); other == id {
		t.Error("two different specs collided on one group_id")
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
