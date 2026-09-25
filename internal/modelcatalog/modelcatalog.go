// Package modelcatalog reads the model list the Declare-a-run form offers from a
// blis-catalog clone, so the list is a fact about the same files blis resolves configs
// against rather than a snapshot maintained by hand. It reads <root>/models/<dir>/, one
// entry per directory, deriving the canonical org-prefixed name from model.yaml and the
// mixture-of-experts flag from config.json.
//
// The catalog root is the clone blis locates via BLIS_CATALOG (no default); the caller
// supplies it. This package never fetches over the network — the clone is provisioned on
// disk (the image bundles it at build time; a developer points BLIS_CATALOG at their own
// checkout).
package modelcatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ErrNotFound is returned by Config when no catalog entry has the requested canonical
// name, so the handler can answer 404 rather than 500.
var ErrNotFound = errors.New("model not found in catalog")

// Model is one offered model: its canonical name and whether blis treats it as MoE.
type Model struct {
	// Name is "<lower(org)>/<dir>": the org from model.yaml's source.repo, lowercased,
	// then the model directory name verbatim (e.g. Qwen/Qwen3-30B-A3B in
	// models/qwen3-30b-a3b → qwen/qwen3-30b-a3b). The org prefix is a leaderboard
	// requirement (schema/run.schema.json's ^[^/]+/[^/]+$) so a model has one canonical
	// spelling and cannot split into two comparability groups.
	Name string `json:"name"`
	// MoE is true when config.json declares experts, so the MoE serving knobs
	// (--enable-expert-parallel, --moe-comm-backend) apply. blis fatally rejects those on
	// a dense model, so the form guards them by this flag.
	MoE bool `json:"moe"`
	// Spec is the architecture summary the Catalog's model cards show without opening a
	// model, derived from the same config.json blis reads. A field the config omits is left
	// zero (empty for strings) and the card omits its row rather than showing a fabricated
	// number.
	Spec Spec `json:"spec"`
}

// Spec is a model's architecture at a glance, read from config.json. Every field is one of
// blis's own numbers from the file it resolves against, not a value derived here. A
// multimodal model keeps these under text_config (as llama-4-scout does), so each field is
// read top-level first and then from text_config — deterministic regardless of map order,
// and always the text tower, never the vision one. `omitempty` drops an absent field from
// the JSON so the client renders undefined the same as a missing row.
type Spec struct {
	Arch      string `json:"arch,omitempty"`      // architectures[0]
	ModelType string `json:"modelType,omitempty"` // model_type
	Context   int64  `json:"context,omitempty"`   // max_position_embeddings, else model_max_length
	Layers    int64  `json:"layers,omitempty"`    // num_hidden_layers
	Hidden    int64  `json:"hidden,omitempty"`    // hidden_size
	Heads     int64  `json:"heads,omitempty"`     // num_attention_heads
	KVHeads   int64  `json:"kvHeads,omitempty"`   // num_key_value_heads
	Dtype     string `json:"dtype,omitempty"`     // torch_dtype
	Experts   int64  `json:"experts,omitempty"`   // num_experts | n_routed_experts | num_local_experts
	Active    int64  `json:"active,omitempty"`    // num_experts_per_tok
	Vocab     int64  `json:"vocab,omitempty"`     // vocab_size
}

// modelYAML is the slice of model.yaml this package reads: the source block, whose repo's
// org half prefixes the canonical name and whose fields are shown as provenance tags.
type modelYAML struct {
	Source struct {
		Provider  string `yaml:"provider"`
		Repo      string `yaml:"repo"`
		Revision  string `yaml:"revision"`
		Retrieved string `yaml:"retrieved"`
	} `yaml:"source"`
}

// Source is a model's provenance from model.yaml: where blis fetches its weights from, and
// when the entry was last retrieved. The model view shows these as tags. A field absent from
// model.yaml is empty and the view omits its tag.
type Source struct {
	Provider  string `json:"provider"`
	Repo      string `json:"repo"`
	Revision  string `json:"revision"`
	Retrieved string `json:"retrieved"`
}

// Detail is one model with everything the Catalog's model view shows on demand: the list
// fields, its provenance (shown as tags), and the config.json blis reads (pretty-printed, or
// empty when the directory ships none).
type Detail struct {
	Name   string `json:"name"`
	MoE    bool   `json:"moe"`
	Source Source `json:"source"`
	Config string `json:"config"`
}

// expertKeys are the config.json keys that mark a model as MoE. A model whose config
// declares any of them is mixture-of-experts; blis reads the same files to decide the
// same thing.
var expertKeys = []string{"num_experts", "n_routed_experts", "num_local_experts"}

// List enumerates the models under <catalogRoot>/models, sorted by Name. An empty root or
// a missing models/ directory is an error (the catalog is required for any run to work, so
// its absence is a misconfiguration to surface, not an empty list). A model directory
// whose model.yaml is missing or whose source.repo carries no "<org>/" prefix cannot be
// given a canonical name and is skipped: a malformed entry should not appear unnamed in
// the picker.
func List(catalogRoot string) ([]Model, error) {
	if catalogRoot == "" {
		return nil, fmt.Errorf("no model catalog: set BLIS_CATALOG to a blis-catalog clone")
	}
	modelsDir := filepath.Join(catalogRoot, "models")
	entries, err := os.ReadDir(modelsDir)
	if err != nil {
		return nil, fmt.Errorf("reading model catalog %s: %w", modelsDir, err)
	}

	models := make([]Model, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := e.Name()
		org, ok := orgOf(filepath.Join(modelsDir, dir))
		if !ok {
			continue
		}
		cfg, err := readConfigJSON(filepath.Join(modelsDir, dir, "config.json"))
		if err != nil {
			return nil, err
		}
		models = append(models, Model{
			Name: strings.ToLower(org) + "/" + dir,
			MoE:  declaresExperts(cfg),
			Spec: deriveSpec(cfg),
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models, nil
}

// Config finds the catalog entry whose canonical name is `name` and returns its detail: the
// MoE flag, the model.yaml provenance, and the pretty-printed config.json. It enumerates the
// catalog and matches on the canonical name rather than building a path from the caller's
// input, so an untrusted name can never read outside the models tree. An unknown name is
// ErrNotFound (404), an unreadable catalog an error (500).
func Config(catalogRoot, name string) (Detail, error) {
	if catalogRoot == "" {
		return Detail{}, fmt.Errorf("no model catalog: set BLIS_CATALOG to a blis-catalog clone")
	}
	modelsDir := filepath.Join(catalogRoot, "models")
	entries, err := os.ReadDir(modelsDir)
	if err != nil {
		return Detail{}, fmt.Errorf("reading model catalog %s: %w", modelsDir, err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := e.Name()
		my, ok := readModelYAML(filepath.Join(modelsDir, dir))
		if !ok {
			continue
		}
		org, _, found := strings.Cut(my.Source.Repo, "/")
		if !found || org == "" {
			continue
		}
		if strings.ToLower(org)+"/"+dir != name {
			continue
		}
		configPath := filepath.Join(modelsDir, dir, "config.json")
		moe, err := isMoE(configPath)
		if err != nil {
			return Detail{}, err
		}
		cfg, err := readConfigPretty(configPath)
		if err != nil {
			return Detail{}, err
		}
		return Detail{
			Name: name,
			MoE:  moe,
			Source: Source{
				Provider:  my.Source.Provider,
				Repo:      my.Source.Repo,
				Revision:  my.Source.Revision,
				Retrieved: my.Source.Retrieved,
			},
			Config: cfg,
		}, nil
	}
	return Detail{}, fmt.Errorf("%q: %w", name, ErrNotFound)
}

// readConfigPretty returns config.json indented for reading. A missing file is "" (not
// every entry ships one, same as isMoE treats it). A present but unparseable file is shown
// verbatim rather than erroring: the viewer should still display what is there, even though
// blis would choke on it.
func readConfigPretty(configPath string) (string, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("reading %s: %w", configPath, err)
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return string(raw), nil
	}
	return buf.String(), nil
}

// orgOf reads model.yaml in dir and returns the org half of source.repo. ok is false when
// the file is missing or the repo carries no "<org>/" prefix, so the caller skips the
// directory rather than emitting a name it cannot make canonical.
func orgOf(dir string) (org string, ok bool) {
	m, ok := readModelYAML(dir)
	if !ok {
		return "", false
	}
	before, _, found := strings.Cut(m.Source.Repo, "/")
	if !found || before == "" {
		return "", false
	}
	return before, true
}

// readModelYAML reads and decodes model.yaml in dir. ok is false when the file is missing or
// will not parse, so a malformed entry is skipped rather than surfaced half-formed.
func readModelYAML(dir string) (modelYAML, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "model.yaml"))
	if err != nil {
		return modelYAML{}, false
	}
	var m modelYAML
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return modelYAML{}, false
	}
	return m, true
}

// isMoE reports whether config.json declares experts. The expert key may sit at the top
// level (e.g. qwen3-30b-a3b) or nested — a multimodal model such as llama-4-scout carries
// it under text_config — so the search is recursive, matching the documented refresh
// (which grepped the whole file) and what blis, which reads the nested config, treats as
// MoE. A missing config.json means dense (not every entry need ship one); a present but
// unparseable one is an error worth surfacing, since it is a file blis itself would choke
// on.
func isMoE(configPath string) (bool, error) {
	cfg, err := readConfigJSON(configPath)
	if err != nil {
		return false, err
	}
	return declaresExperts(cfg), nil
}

// readConfigJSON reads and decodes config.json to a generic tree. A missing file is (nil,
// nil): not every entry ships a config, and a nil tree reads as dense with an empty spec. A
// present but unparseable file is an error worth surfacing, since it is one blis would choke
// on too.
func readConfigJSON(configPath string) (any, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", configPath, err)
	}
	var cfg any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", configPath, err)
	}
	return cfg, nil
}

// deriveSpec pulls the architecture summary the model cards show out of a decoded
// config.json. A tree that is not an object (a missing config, or a malformed one) yields
// the zero Spec, so the card falls back to name and MoE flag alone.
func deriveSpec(cfg any) Spec {
	m, ok := cfg.(map[string]any)
	if !ok {
		return Spec{}
	}
	return Spec{
		Arch:      firstArch(m),
		ModelType: pickString(m, "model_type"),
		Context:   firstInt(m, "max_position_embeddings", "model_max_length"),
		Layers:    pickInt(m, "num_hidden_layers"),
		Hidden:    pickInt(m, "hidden_size"),
		Heads:     pickInt(m, "num_attention_heads"),
		KVHeads:   pickInt(m, "num_key_value_heads"),
		Dtype:     pickString(m, "torch_dtype"),
		Experts:   firstInt(m, "num_experts", "n_routed_experts", "num_local_experts"),
		Active:    pickInt(m, "num_experts_per_tok"),
		Vocab:     pickInt(m, "vocab_size"),
	}
}

// pick looks a key up at the top level, then under text_config — the text tower of a
// multimodal config, where a model like llama-4-scout keeps these fields. It reads the two
// named locations rather than walking the whole tree, so the result never depends on Go's
// randomized map order and never picks up the vision tower's numbers.
func pick(m map[string]any, key string) (any, bool) {
	if v, ok := m[key]; ok {
		return v, true
	}
	if tc, ok := m["text_config"].(map[string]any); ok {
		if v, ok := tc[key]; ok {
			return v, true
		}
	}
	return nil, false
}

// pickInt reads a key as an integer. JSON numbers decode to float64; a non-number or absent
// key is 0, which Spec's omitempty then drops.
func pickInt(m map[string]any, key string) int64 {
	if v, ok := pick(m, key); ok {
		if f, ok := v.(float64); ok {
			return int64(f)
		}
	}
	return 0
}

// pickString reads a key as a string, "" when absent or not a string.
func pickString(m map[string]any, key string) string {
	if v, ok := pick(m, key); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// firstInt returns the first of keys that reads as a non-zero integer, so a value is found
// under whichever key a given config uses: the expert count under num_experts /
// n_routed_experts / num_local_experts, and the context window under
// max_position_embeddings, falling back to model_max_length (which a config such as inkling
// uses in its place).
func firstInt(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		if n := pickInt(m, k); n != 0 {
			return n
		}
	}
	return 0
}

// firstArch returns architectures[0], always read at the top level (the outer model, e.g.
// Llama4ForConditionalGeneration, not the text tower's inner architecture).
func firstArch(m map[string]any) string {
	if arr, ok := m["architectures"].([]any); ok && len(arr) > 0 {
		if s, ok := arr[0].(string); ok {
			return s
		}
	}
	return ""
}

// declaresExperts walks a decoded config.json for an expert key at any nesting depth.
func declaresExperts(node any) bool {
	switch v := node.(type) {
	case map[string]any:
		for _, k := range expertKeys {
			if _, present := v[k]; present {
				return true
			}
		}
		for _, child := range v {
			if declaresExperts(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if declaresExperts(child) {
				return true
			}
		}
	}
	return false
}
