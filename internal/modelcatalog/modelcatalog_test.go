package modelcatalog

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

const catalogRoot = "testdata/catalog"

func TestConfigReturnsProvenanceAndPrettyConfig(t *testing.T) {
	d, err := Config(catalogRoot, "", "qwen/qwen3-30b-a3b")
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
	d, err := Config(catalogRoot, "", "someorg/dense-no-config")
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
	_, err := Config(catalogRoot, "", "acme/does-not-exist")
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
	got, err := List(filepath.Join("testdata", "catalog"), "")
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
		// Compare name and MoE flag only; the derived Spec is covered by TestListDerivesSpec.
		if got[i].Name != want[i].Name || got[i].MoE != want[i].MoE {
			t.Errorf("model %d: got %+v, want name %q MoE %v", i, got[i], want[i].Name, want[i].MoE)
		}
	}
}

// List derives each model's architecture spec from the same config.json it reads for the
// MoE flag. The two MoE fixtures cover the deterministic top-level-then-text_config lookup:
// qwen3-30b-a3b keeps its fields at the top level, while scout-nested-moe (a stand-in for a
// multimodal model like llama-4-scout) keeps hidden_size and its expert key under
// text_config, and both must resolve.
func TestListDerivesSpec(t *testing.T) {
	got, err := List(filepath.Join("testdata", "catalog"), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	specs := make(map[string]Spec, len(got))
	for _, m := range got {
		specs[m.Name] = m.Spec
	}

	// Context comes from max_position_embeddings when the config states it.
	if s := specs["qwen/qwen3-30b-a3b"]; s.Arch != "Qwen3MoeForCausalLM" || s.Hidden != 2048 || s.Experts != 128 || s.Context != 40960 {
		t.Errorf("qwen3-30b-a3b spec = %+v, want arch Qwen3MoeForCausalLM, hidden 2048, experts 128, context 40960", s)
	}
	// Nested under text_config: hidden_size 5120 and num_local_experts 16, with the outer
	// architectures still read at the top level. Context falls back to model_max_length
	// (also under text_config) since this config states no max_position_embeddings — the
	// case that left inkling's card showing "not stated".
	if s := specs["meta-llama/scout-nested-moe"]; s.Arch != "Llama4" || s.Hidden != 5120 || s.Experts != 16 || s.Context != 10485760 {
		t.Errorf("scout-nested-moe spec = %+v, want arch Llama4, hidden 5120 (text_config), experts 16 (text_config), context 10485760 (model_max_length)", s)
	}
	// A model that ships no config.json has the zero spec, not a fabricated one.
	if s := specs["someorg/dense-no-config"]; s != (Spec{}) {
		t.Errorf("dense-no-config spec = %+v, want zero Spec", s)
	}
}

// A model whose directory name is present in the user-models store is tagged "user"; every
// other model is "base". Membership is by directory name, matching how the boot overlay
// copies <user-models>/<dir> onto <catalog>/models/<dir>.
func TestListMarksUserSource(t *testing.T) {
	userDir := filepath.Join("testdata", "user-models")
	got, err := List(filepath.Join("testdata", "catalog"), userDir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	origin := make(map[string]string, len(got))
	for _, m := range got {
		origin[m.Name] = m.Origin
	}
	if origin["qwen/qwen3-30b-a3b"] != "user" {
		t.Errorf("qwen3-30b-a3b source = %q, want user (it is in the user store)", origin["qwen/qwen3-30b-a3b"])
	}
	if origin["meta-llama/llama-3.1-8b-instruct"] != "base" {
		t.Errorf("llama-3.1-8b-instruct source = %q, want base", origin["meta-llama/llama-3.1-8b-instruct"])
	}
}

// An empty user-store path (local dev without a store, or a fresh deploy) marks every model
// base rather than erroring.
func TestListNoUserStoreMarksAllBase(t *testing.T) {
	got, err := List(filepath.Join("testdata", "catalog"), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, m := range got {
		if m.Origin != "base" {
			t.Errorf("%s source = %q, want base when there is no user store", m.Name, m.Origin)
		}
	}
}

func TestListEmptyRootIsError(t *testing.T) {
	if _, err := List("", ""); err == nil {
		t.Fatal("expected an error for an empty catalog root, got nil")
	}
}

func TestListMissingModelsDirIsError(t *testing.T) {
	// A root that exists but has no models/ subdirectory: a misconfiguration to surface,
	// not an empty list.
	if _, err := List(filepath.Join("testdata", "empty-root"), ""); err == nil {
		t.Fatal("expected an error when models/ is missing, got nil")
	}
}
