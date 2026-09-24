package modelcatalog

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

const catalogRoot = "testdata/catalog"

func TestConfigReturnsProvenanceAndPrettyConfig(t *testing.T) {
	d, err := Config(catalogRoot, "qwen/qwen3-30b-a3b")
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if !d.MoE {
		t.Error("qwen3-30b-a3b should be MoE")
	}
	if d.Source.Repo != "Qwen/Qwen3-30B-A3B" || d.Source.Revision != "abc123" {
		t.Errorf("source = %+v, want repo Qwen/Qwen3-30B-A3B @ abc123", d.Source)
	}
	if !strings.Contains(d.Config, "num_experts") {
		t.Errorf("config should carry the raw config.json, got %q", d.Config)
	}
	// Provider is carried through model.yaml's source block for the provenance tags.
	if d.Source.Provider != "huggingface" {
		t.Errorf("source.provider = %q, want huggingface", d.Source.Provider)
	}
	// config.json is pretty-printed for reading: the fixture is a single minified line, so
	// indentation only appears if it was reformatted.
	if !strings.Contains(d.Config, "\n  ") {
		t.Errorf("config should be indented, got %q", d.Config)
	}
}

func TestConfigModelWithoutConfigJSONHasEmptyConfig(t *testing.T) {
	d, err := Config(catalogRoot, "someorg/dense-no-config")
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if d.MoE {
		t.Error("a model with no config.json is dense")
	}
	if d.Config != "" {
		t.Errorf("config = %q, want empty for a model that ships no config.json", d.Config)
	}
}

func TestConfigUnknownNameIsNotFound(t *testing.T) {
	_, err := Config(catalogRoot, "acme/does-not-exist")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Config unknown name error = %v, want ErrNotFound", err)
	}
}

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
