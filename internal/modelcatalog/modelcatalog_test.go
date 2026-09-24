package modelcatalog

import (
	"path/filepath"
	"testing"
)

// The fixture tree under testdata/catalog/models covers: a MoE model whose org needs
// lowercasing (Qwen), a dense model, a MoE model flagged by a different top-level expert
// key (num_local_experts), a MoE model whose expert key is nested under text_config (a
// multimodal model, as llama-4-scout is), a malformed entry with no org prefix (skipped),
// and a dense model with no config.json (listed, dense).
func TestListReadsNamesAndMoE(t *testing.T) {
	got, err := List(filepath.Join("testdata", "catalog"))
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	// Sorted by name; the malformed broken-no-org entry is absent.
	want := []Model{
		{Name: "meta-llama/llama-3.1-8b-instruct", MoE: false},
		{Name: "meta-llama/scout-nested-moe", MoE: true},
		{Name: "mistralai/mixtral-8x7b-v0.1", MoE: true},
		{Name: "qwen/qwen3-30b-a3b", MoE: true},
		{Name: "someorg/dense-no-config", MoE: false},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d models %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("model %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestListEmptyRootIsError(t *testing.T) {
	if _, err := List(""); err == nil {
		t.Fatal("expected an error for an empty catalog root, got nil")
	}
}

func TestListMissingModelsDirIsError(t *testing.T) {
	// A root that exists but has no models/ subdirectory: a misconfiguration to surface,
	// not an empty list.
	if _, err := List(filepath.Join("testdata", "empty-root")); err == nil {
		t.Fatal("expected an error when models/ is missing, got nil")
	}
}
