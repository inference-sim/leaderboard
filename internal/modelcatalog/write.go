package modelcatalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// dirPattern constrains a user-model directory name. It is a single path segment written
// under <catalog>/models/ and the user store, so it allows only lower-case letters, digits,
// dash, underscore and dot, and must start with a letter or digit. That rejects "", "..",
// a leading dot, any "/" and upper-case, so a crafted value cannot escape the models tree or
// collide with the hidden/system entries os.ReadDir would surface.
var dirPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// Submission is a proposed user model from the web form: a directory name and the two file
// bodies, verbatim. The directory name becomes the model-half of the canonical name; the
// org-half is read from model.yaml.
type Submission struct {
	Dir        string
	ModelYAML  string
	ConfigJSON string
}

// Validated is what structural validation derived from a submission, for the form to show
// before (and the server to store after) a save. It does not prove blis can run the model;
// that is the smoke test's job.
type Validated struct {
	// Name is the canonical "<lower(org)>/<dir>" blis resolves the model by.
	Name string
	// MoE is whether config.json declares experts, so the Declare form offers the MoE knobs.
	MoE bool
	// Provider is model.yaml's source.provider, shown as a provenance tag.
	Provider string
}

// Validate checks a submission structurally and derives its canonical name, MoE flag and
// provider. It parses model.yaml for an org-prefixed source.repo (so a canonical name is
// derivable) and config.json as JSON (so blis will not choke on it). It does NOT check the
// catalog for a name collision (the caller does, via List) and does NOT run blis.
func (s Submission) Validate() (Validated, error) {
	if !dirPattern.MatchString(s.Dir) {
		return Validated{}, fmt.Errorf("model directory %q must be lower-case letters, digits, "+
			"dash, underscore or dot, starting with a letter or digit", s.Dir)
	}

	var my modelYAML
	if err := yaml.Unmarshal([]byte(s.ModelYAML), &my); err != nil {
		return Validated{}, fmt.Errorf("model.yaml is not valid YAML: %w", err)
	}
	org, _, found := strings.Cut(my.Source.Repo, "/")
	if !found || org == "" {
		return Validated{}, fmt.Errorf("model.yaml source.repo %q has no \"<org>/\" prefix; it is "+
			"needed to form the canonical model name", my.Source.Repo)
	}

	var cfg any
	if err := json.Unmarshal([]byte(s.ConfigJSON), &cfg); err != nil {
		return Validated{}, fmt.Errorf("config.json is not valid JSON: %w", err)
	}

	return Validated{
		Name:     strings.ToLower(org) + "/" + s.Dir,
		MoE:      declaresExperts(cfg),
		Provider: my.Source.Provider,
	}, nil
}

// Store writes and removes user models, keeping the pristine user-models store and the live
// catalog in step. The pristine store is the durable source of truth (re-overlaid onto the
// catalog on every boot); the live catalog copy makes a model usable immediately, with no
// restart.
type Store struct {
	// CatalogRoot is the live blis-catalog root (BLIS_CATALOG); models live under models/.
	CatalogRoot string
	// UserModelsDir is the pristine user-models store.
	UserModelsDir string
}

// Save validates a submission and writes model.yaml and config.json to both the pristine
// store and the live catalog. It overwrites an existing user model (the edit path); the
// caller must have ensured the name does not collide with a base model (the "new names only"
// rule), since Save does not read the catalog.
func (st Store) Save(s Submission) error {
	if _, err := s.Validate(); err != nil {
		return err
	}
	for _, dir := range st.dirs(s.Dir) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "model.yaml"), []byte(s.ModelYAML), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", filepath.Join(dir, "model.yaml"), err)
		}
		if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(s.ConfigJSON), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", filepath.Join(dir, "config.json"), err)
		}
	}
	return nil
}

// Delete removes a user model from both the pristine store and the live catalog. A missing
// directory is not an error (the two can drift if a boot overlay has not run yet).
func (st Store) Delete(dir string) error {
	if !dirPattern.MatchString(dir) {
		return fmt.Errorf("model directory %q is not a valid name", dir)
	}
	for _, d := range st.dirs(dir) {
		if err := os.RemoveAll(d); err != nil {
			return fmt.Errorf("remove %s: %w", d, err)
		}
	}
	return nil
}

// dirs is the pair of directories a user model occupies: the pristine store and the live
// catalog's models/ tree. The store is omitted when unset (local dev may run without one),
// so a model is still written to the live catalog.
func (st Store) dirs(dir string) []string {
	paths := []string{filepath.Join(st.CatalogRoot, "models", dir)}
	if st.UserModelsDir != "" {
		paths = append(paths, filepath.Join(st.UserModelsDir, dir))
	}
	return paths
}
