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
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

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

// modelYAML is the slice of model.yaml this package reads: the HuggingFace source repo,
// whose org half prefixes the canonical name.
type modelYAML struct {
	Source struct {
		Repo string `yaml:"repo"`
	} `yaml:"source"`
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

// orgOf reads model.yaml in dir and returns the org half of source.repo. ok is false when
// the file is missing or the repo carries no "<org>/" prefix, so the caller skips the
// directory rather than emitting a name it cannot make canonical.
func orgOf(dir string) (org string, ok bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "model.yaml"))
	if err != nil {
		return "", false
	}
	var m modelYAML
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return "", false
	}
	before, _, found := strings.Cut(m.Source.Repo, "/")
	if !found || before == "" {
		return "", false
	}
	return before, true
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
