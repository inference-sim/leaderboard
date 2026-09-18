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
