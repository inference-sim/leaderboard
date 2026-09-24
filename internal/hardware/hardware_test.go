package hardware

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	c, err := Load(filepath.Join("testdata", "hardware_config.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func TestKnown(t *testing.T) {
	c := testCatalog(t)
	for _, name := range []string{"H100", "A100-SXM", "A100-80", "L40S"} {
		if !c.Known(name) {
			t.Errorf("Known(%q) = false", name)
		}
	}
	if c.Known("H200") {
		t.Error(`Known("H200") = true, want false`)
	}
	if c.Known("_comment") {
		t.Error(`prose keys must not become hardware names`)
	}
}

// The design-time matrix ran A100-80 and A100-SXM as separate candidates and got a
// duplicate row: upstream documents A100-80 as an alias with identical specs.
func TestAliasesFindsSpecIdenticalHardware(t *testing.T) {
	c := testCatalog(t)
	if got := c.Aliases("A100-80"); !reflect.DeepEqual(got, []string{"A100-SXM"}) {
		t.Errorf(`Aliases("A100-80") = %v, want ["A100-SXM"]`, got)
	}
	if got := c.Aliases("A100-SXM"); !reflect.DeepEqual(got, []string{"A100-80"}) {
		t.Errorf(`Aliases("A100-SXM") = %v, want ["A100-80"]`, got)
	}
	if got := c.Aliases("H100"); len(got) != 0 {
		t.Errorf(`Aliases("H100") = %v, want none`, got)
	}
	if got := c.Aliases("H200"); len(got) != 0 {
		t.Errorf(`Aliases on unknown hardware = %v, want none`, got)
	}
}

func TestNamesExcludesProseKeysAndIsSorted(t *testing.T) {
	c := testCatalog(t)
	want := []string{"A100-80", "A100-SXM", "H100", "L40S"}
	if got := c.Names(); !reflect.DeepEqual(got, want) {
		t.Errorf("Names() = %v, want %v", got, want)
	}
}

func TestEntriesAreSortedWithAliasesAndSpecs(t *testing.T) {
	c := testCatalog(t)
	entries := c.Entries()

	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	if want := []string{"A100-80", "A100-SXM", "H100", "L40S"}; !reflect.DeepEqual(names, want) {
		t.Errorf("Entries names = %v, want %v", names, want)
	}

	byName := make(map[string]Entry, len(entries))
	for _, e := range entries {
		byName[e.Name] = e
	}
	// The spec-identical pair carries each other as an alias; a distinct accelerator
	// carries none.
	if got := byName["A100-80"].Aliases; !reflect.DeepEqual(got, []string{"A100-SXM"}) {
		t.Errorf("A100-80 aliases = %v, want [A100-SXM]", got)
	}
	if got := byName["H100"].Aliases; len(got) != 0 {
		t.Errorf("H100 aliases = %v, want none", got)
	}
	// The numeric spec is carried through verbatim for the page to render.
	if got := byName["H100"].Spec["MemoryGiB"]; got != 80.0 {
		t.Errorf("H100 MemoryGiB = %v, want 80", got)
	}
	if got := byName["H100"].Spec["TFlopsPeak"]; got != 989.5 {
		t.Errorf("H100 TFlopsPeak = %v, want 989.5", got)
	}
}

func TestLoadMissingFileNamesThePath(t *testing.T) {
	_, err := Load(filepath.Join("testdata", "nope.json"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "nope.json") {
		t.Errorf("error should name the path, got %v", err)
	}
}

// TestIntegrationFixtureMatchesUpstream fails when the trimmed testdata copy
// drifts from the real catalogue. Gated because it needs the sibling checkout.
func TestIntegrationFixtureMatchesUpstream(t *testing.T) {
	if os.Getenv("LEADERBOARD_INTEGRATION") == "" {
		t.Skip("set LEADERBOARD_INTEGRATION=1 and clone ../inference-sim to run")
	}
	upstream, err := Load(filepath.Join("..", "..", DefaultConfigPath))
	if err != nil {
		t.Fatalf("load upstream: %v", err)
	}
	local := testCatalog(t)
	if !reflect.DeepEqual(upstream.Names(), local.Names()) {
		t.Errorf("hardware names drifted\nupstream: %v\n testdata: %v",
			upstream.Names(), local.Names())
	}
	for _, name := range upstream.Names() {
		u, _ := schema.CanonicalJSON(upstream.specs[name])
		l, _ := schema.CanonicalJSON(local.specs[name])
		if string(u) != string(l) {
			t.Errorf("%s spec drifted\nupstream: %s\n testdata: %s", name, u, l)
		}
	}
}
