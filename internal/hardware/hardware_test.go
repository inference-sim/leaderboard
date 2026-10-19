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
	c, err := Load(filepath.Join("testdata", "hardware"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func TestKnown(t *testing.T) {
	c := testCatalog(t)
	for _, name := range []string{"h100", "h200", "b200", "a100-sxm", "a100-80", "l40s"} {
		if !c.Known(name) {
			t.Errorf("Known(%q) = false", name)
		}
	}
	if c.Known("NO-SUCH-GPU") {
		t.Error(`Known("NO-SUCH-GPU") = true, want false`)
	}
	// A hardware spec must not leak the catalog's "_comment*" prose keys.
	for _, e := range c.Entries() {
		for k := range e.Spec {
			if strings.HasPrefix(k, "_comment") {
				t.Errorf("%s spec retains prose key %q", e.Name, k)
			}
		}
	}
}

// The design-time matrix ran A100-80 and A100-SXM as separate candidates and got a
// duplicate row: upstream documents A100-80 as an alias with identical specs.
func TestAliasesFindsSpecIdenticalHardware(t *testing.T) {
	c := testCatalog(t)
	if got := c.Aliases("a100-80"); !reflect.DeepEqual(got, []string{"a100-sxm"}) {
		t.Errorf(`Aliases("a100-80") = %v, want ["a100-sxm"]`, got)
	}
	if got := c.Aliases("a100-sxm"); !reflect.DeepEqual(got, []string{"a100-80"}) {
		t.Errorf(`Aliases("a100-sxm") = %v, want ["a100-80"]`, got)
	}
	if got := c.Aliases("h100"); len(got) != 0 {
		t.Errorf(`Aliases("h100") = %v, want none`, got)
	}
	if got := c.Aliases("NO-SUCH-GPU"); len(got) != 0 {
		t.Errorf(`Aliases on unknown hardware = %v, want none`, got)
	}
}

// wantNames is the sorted hardware set the testdata fixture (a copy of the catalog's
// hardware/) carries, including the Blackwell parts v0.10.0's catalog adds.
var wantNames = []string{"a100-80", "a100-sxm", "b200", "b300", "gb200-nvl72", "gb300", "h100", "h200", "l40s"}

func TestNamesExcludesProseKeysAndIsSorted(t *testing.T) {
	c := testCatalog(t)
	if got := c.Names(); !reflect.DeepEqual(got, wantNames) {
		t.Errorf("Names() = %v, want %v", got, wantNames)
	}
}

func TestEntriesAreSortedWithAliasesAndSpecs(t *testing.T) {
	c := testCatalog(t)
	entries := c.Entries()

	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	if !reflect.DeepEqual(names, wantNames) {
		t.Errorf("Entries names = %v, want %v", names, wantNames)
	}

	byName := make(map[string]Entry, len(entries))
	for _, e := range entries {
		byName[e.Name] = e
	}
	// The spec-identical pair carries each other as an alias; a distinct accelerator
	// carries none.
	if got := byName["a100-80"].Aliases; !reflect.DeepEqual(got, []string{"a100-sxm"}) {
		t.Errorf("a100-80 aliases = %v, want [a100-sxm]", got)
	}
	if got := byName["h100"].Aliases; len(got) != 0 {
		t.Errorf("h100 aliases = %v, want none", got)
	}
	// The numeric spec is carried through verbatim for the page to render.
	if got := byName["h100"].Spec["MemoryGiB"]; got != 80.0 {
		t.Errorf("h100 MemoryGiB = %v, want 80", got)
	}
	if got := byName["h100"].Spec["TFlopsPeak"]; got != 989.5 {
		t.Errorf("h100 TFlopsPeak = %v, want 989.5", got)
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

// TestIntegrationFixtureMatchesUpstream fails when the testdata copy drifts from the
// real catalogue's hardware/ dir. Gated because it needs the blis-catalog clone, found
// via BLIS_CATALOG (the same root serve/run read).
func TestIntegrationFixtureMatchesUpstream(t *testing.T) {
	if os.Getenv("LEADERBOARD_INTEGRATION") == "" {
		t.Skip("set LEADERBOARD_INTEGRATION=1 and clone ../inference-sim to run")
	}
	catalogRoot := os.Getenv("BLIS_CATALOG")
	if catalogRoot == "" {
		t.Skip("set BLIS_CATALOG to a blis-catalog clone to run")
	}
	upstream, err := Load(Dir(catalogRoot))
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
