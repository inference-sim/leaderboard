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
		moe, err := isMoE(filepath.Join(modelsDir, dir, "config.json"))
		if err != nil {
			return nil, err
		}
		models = append(models, Model{Name: strings.ToLower(org) + "/" + dir, MoE: moe})
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
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("reading %s: %w", configPath, err)
	}
	var cfg any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return false, fmt.Errorf("parsing %s: %w", configPath, err)
	}
	return declaresExperts(cfg), nil
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
