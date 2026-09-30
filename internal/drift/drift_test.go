package drift

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

func TestRequiredJSONFieldsMatchesEncodingJSONEmission(t *testing.T) {
	got, err := RequiredJSONFields(
		filepath.Join("testdata", "metrics_utils_sample.go.txt"), "MetricsOutput")
	if err != nil {
		t.Fatalf("RequiredJSONFields: %v", err)
	}
	// encoding/json always emits: the three plainly json-tagged fields, plus
	// Untagged, EmptyName (a `json:","` tag with no name) and OtherTagged (a tag
	// with no json key at all) under their Go names, plus NonOmitOpt under its
	// tag name since "string" is not "omitempty". It never emits CacheHitRate or
	// Requests (omitempty), Internal (`json:"-"`), or unexported.
	want := []string{
		"instance_id", "completed_requests", "e2e_p99_ms",
		"Untagged", "EmptyName", "OtherTagged", "non_omit",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestRequiredJSONFieldsRejectsUnresolvedEmbedding(t *testing.T) {
	_, err := RequiredJSONFields(
		filepath.Join("testdata", "metrics_utils_sample.go.txt"), "Embedder")
	if err == nil {
		t.Fatal("expected an error for an untagged anonymous embedded field")
	}
	if !strings.Contains(err.Error(), "Inline") {
		t.Errorf("error should name the embedded field, got %v", err)
	}
}

func TestRequiredJSONFieldsNamesAMissingType(t *testing.T) {
	_, err := RequiredJSONFields(
		filepath.Join("testdata", "metrics_utils_sample.go.txt"), "NoSuchType")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "NoSuchType") {
		t.Errorf("error should name the type, got %v", err)
	}
}

// AllJSONFields includes the omitempty fields RequiredJSONFields drops, because the
// optional-presence guard (§4.3) depends on cache_hit_rate and kv_allocation_failures —
// both omitempty upstream — still existing by name.
func TestAllJSONFieldsIncludesOmitempty(t *testing.T) {
	got, err := AllJSONFields(
		filepath.Join("testdata", "metrics_utils_sample.go.txt"), "MetricsOutput")
	if err != nil {
		t.Fatalf("AllJSONFields: %v", err)
	}
	set := map[string]bool{}
	for _, n := range got {
		set[n] = true
	}
	// The omitempty pair RequiredJSONFields excludes must be present here.
	for _, want := range []string{"cache_hit_rate", "requests"} {
		if !set[want] {
			t.Errorf("AllJSONFields is missing omitempty field %q: %v", want, got)
		}
	}
	// It still excludes the dashed and unexported fields, like RequiredJSONFields.
	for _, absent := range []string{"-", "Internal", "unexported"} {
		if set[absent] {
			t.Errorf("AllJSONFields should not include %q", absent)
		}
	}
}

// FileContains reports whether a source file carries a literal substring, and errors on
// a missing file rather than reporting a false absence — the label guard relies on that
// distinction so a moved upstream file fails loudly instead of passing as "not found".
func TestFileContains(t *testing.T) {
	path := filepath.Join("testdata", "metrics_utils_sample.go.txt")
	if ok, err := FileContains(path, "MetricsOutput"); err != nil || !ok {
		t.Errorf("FileContains(MetricsOutput) = %v, %v; want true, nil", ok, err)
	}
	if ok, err := FileContains(path, "no such marker here"); err != nil || ok {
		t.Errorf("FileContains(absent) = %v, %v; want false, nil", ok, err)
	}
	if _, err := FileContains(filepath.Join("testdata", "does-not-exist.go"), "x"); err == nil {
		t.Error("FileContains on a missing file must error, not report absence")
	}
}

func TestCompareReportsBothDirections(t *testing.T) {
	if err := Compare([]string{"a", "b"}, []string{"b", "a"}); err != nil {
		t.Errorf("order must not matter: %v", err)
	}

	err := Compare([]string{"a", "b", "c"}, []string{"a", "b"})
	if err == nil {
		t.Fatal("expected an error for a new upstream field")
	}
	if !strings.Contains(err.Error(), "c") || !strings.Contains(err.Error(), "upstream") {
		t.Errorf("error should name the new field and its direction, got %v", err)
	}

	err = Compare([]string{"a"}, []string{"a", "gone"})
	if err == nil {
		t.Fatal("expected an error for a field the schema requires but upstream dropped")
	}
	if !strings.Contains(err.Error(), "gone") {
		t.Errorf("error should name the dropped field, got %v", err)
	}
}

// TestUpstreamMetricsOutputMatchesTheContract is the check the spec asked for: it
// fails loudly when upstream adds a required field. It reads upstream source rather
// than importing the module, so there is no replace directive and no build coupling
// to a repo that must stay read-only.
func TestUpstreamMetricsOutputMatchesTheContract(t *testing.T) {
	path := filepath.Join("..", "..", DefaultMetricsPath)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("upstream not present at %s — run `make drift` with the sibling "+
			"checkout to enforce this", path)
	}
	upstream, err := RequiredJSONFields(path, "MetricsOutput")
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	contract, err := schema.RequiredCoreNames()
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	if len(upstream) != 27 {
		t.Errorf("upstream MetricsOutput has %d non-omitempty json fields, want 27: %v",
			len(upstream), upstream)
	}
	if err := Compare(upstream, contract); err != nil {
		t.Errorf("schema/run.schema.json is out of date with upstream:\n%v", err)
	}
}

// TestUpstreamRetainsOptionalKVFields guards the promoted KV metrics that the
// required-core check above cannot see, because they are omitempty upstream (§4.3). It
// turns an upstream rename — which would otherwise silently blank a leaderboard column —
// into a loud failure: the two file-only metrics must still exist by name in
// MetricsOutput, and the stdout label the thrashing-rate scraper depends on must still be
// printed by printKVCacheMetrics.
func TestUpstreamRetainsOptionalKVFields(t *testing.T) {
	metricsPath := filepath.Join("..", "..", DefaultMetricsPath)
	if _, err := os.Stat(metricsPath); err != nil {
		t.Skipf("upstream not present at %s — run `make drift` with the sibling checkout", metricsPath)
	}
	fields, err := AllJSONFields(metricsPath, "MetricsOutput")
	if err != nil {
		t.Fatalf("parse upstream MetricsOutput: %v", err)
	}
	present := map[string]bool{}
	for _, n := range fields {
		present[n] = true
	}
	// These two are read from the metrics file into typed Metrics fields (SplitMetrics),
	// so a rename would blank the Cache hit / KV alloc fails columns without any parse error.
	for _, want := range []string{"cache_hit_rate", "kv_allocation_failures"} {
		if !present[want] {
			t.Errorf("upstream MetricsOutput no longer has a %q field; the leaderboard's "+
				"typed metric would silently blank — rename it in schema.Metrics and the schema", want)
		}
	}

	// The thrashing rate is scraped from stdout, so guard the exact label the parser keys on.
	runCmdPath := filepath.Join("..", "..", DefaultRunCmdPath)
	if _, err := os.Stat(runCmdPath); err != nil {
		t.Skipf("upstream not present at %s", runCmdPath)
	}
	ok, err := FileContains(runCmdPath, KVThrashingStdoutLabel)
	if err != nil {
		t.Fatalf("read upstream run command: %v", err)
	}
	if !ok {
		t.Errorf("upstream %s no longer prints %q; parseKVThrashing would silently return nil "+
			"for every run — update the label in internal/blisrun and here", DefaultRunCmdPath, KVThrashingStdoutLabel)
	}
}
