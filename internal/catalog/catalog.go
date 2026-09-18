// Package catalog reads and writes workloads.yaml: the set of named, reusable workload
// profiles. A profile is the work offered minus model (P1) — the seed, observation
// window, request timeout, and workload definition — with a unique name. Model is
// chosen at run time, so it is never stored here.
//
// The file is a local artifact (server writes it to <out>/workloads.yaml, gitignored),
// not a committed one: the design's P2 proposed committing it at the repo root, but the
// repo owner chose to keep it local alongside the results instead.
//
// The catalog's own schema_version is independent of the record schema (a profile is
// not a record): the two evolve separately.
package catalog

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// SchemaVersion is the only catalog version this build reads or writes.
const SchemaVersion = 1

// defaultRequestTimeoutS mirrors --timeout's upstream default (cmd/root.go:3149) and
// internal/spec.defaultRequestTimeoutS.
const defaultRequestTimeoutS = 300

// Catalog is a loaded workloads.yaml: the profiles, in file order.
type Catalog struct {
	Profiles []Profile
}

// Profile is one named workload: a comparability group with model factored out.
type Profile struct {
	Name            string
	Seed            int64
	HorizonTicks    *int64
	RequestTimeoutS int
	Workload        Workload

	// Builtin marks one of the leaderboard's shipped presets (§11): read-only, never
	// written to workloads.yaml, and present on every instance independent of the file.
	Builtin bool
}

// Workload is a profile's work definition in its authored (clean) form: the classic
// distribution fields, or an inline blis WorkloadSpec. The variant is Type. Unlike
// schema.Workload — the record shape, which carries not-applicable placeholders so it
// can stay a single type — this holds only the fields the variant actually uses.
type Workload struct {
	Type string

	// Distribution fields (Type == "distribution").
	NumRequests       int
	Load              schema.Load
	PromptTokens      int
	PromptTokensStdev int
	OutputTokens      int
	OutputTokensStdev int

	// Spec is the inline blis WorkloadSpec (v2), model-free (Type == "workload-spec").
	Spec map[string]any
}

// --- on-disk YAML shape -----------------------------------------------------------

type fileYAML struct {
	SchemaVersion int           `yaml:"schema_version"`
	Workloads     []profileYAML `yaml:"workloads"`
}

type profileYAML struct {
	Name            string       `yaml:"name"`
	Seed            int64        `yaml:"seed"`
	HorizonTicks    *int64       `yaml:"horizon_ticks"`
	RequestTimeoutS *int         `yaml:"request_timeout_s"`
	Workload        workloadYAML `yaml:"workload"`
}

type workloadYAML struct {
	Type string `yaml:"type"`

	NumRequests       int       `yaml:"num_requests,omitempty"`
	Load              *loadYAML `yaml:"load,omitempty"`
	PromptTokens      int       `yaml:"prompt_tokens,omitempty"`
	PromptTokensStdev int       `yaml:"prompt_tokens_stdev,omitempty"`
	OutputTokens      int       `yaml:"output_tokens,omitempty"`
	OutputTokensStdev int       `yaml:"output_tokens_stdev,omitempty"`

	// SpecSHA256 is written for provenance and re-validated on read; the read value is
	// recomputed from Spec, so a hand-edited file that disagrees is rejected.
	SpecSHA256 *string        `yaml:"spec_sha256,omitempty"`
	Spec       map[string]any `yaml:"spec,omitempty"`
}

type loadYAML struct {
	Kind  string  `yaml:"kind"`
	Value float64 `yaml:"value"`
}

// Read parses workloads.yaml, validates every profile, and enforces the catalog-wide
// invariants (unique name AND unique content, P3). A missing file is the empty
// catalog, not an error: a fresh checkout has authored no workloads yet.
func Read(path string) (*Catalog, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return &Catalog{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("catalog: read %s: %w", path, err)
	}

	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true) // a typo in a profile field is an error, not a silent default
	var f fileYAML
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("catalog: parse %s: %w", path, err)
	}
	if f.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("catalog: schema_version %d, this build reads %d",
			f.SchemaVersion, SchemaVersion)
	}

	c := &Catalog{}
	for i, py := range f.Workloads {
		p, err := py.toProfile()
		if err != nil {
			return nil, fmt.Errorf("catalog: workloads[%d] (%s): %w", i, py.Name, err)
		}
		c.Profiles = append(c.Profiles, p)
	}
	if err := c.check(); err != nil {
		return nil, err
	}
	return c, nil
}

// Load is the effective catalog the server operates on: the shipped presets (§11)
// prepended to the user's file, then re-checked as one set. So the P3 unique-name-and-
// content invariant spans presets too — a user profile that names or twins a preset
// falls out of check() for free — and the presets are present even when the file is
// absent. Read stays pure file I/O; only Load knows about presets.
func Load(path string) (*Catalog, error) {
	fileCat, err := Read(path)
	if err != nil {
		return nil, err
	}
	c := &Catalog{Profiles: append(Presets(), fileCat.Profiles...)}
	if err := c.check(); err != nil {
		return nil, err
	}
	return c, nil
}

func (py profileYAML) toProfile() (Profile, error) {
	timeout := defaultRequestTimeoutS
	if py.RequestTimeoutS != nil {
		timeout = *py.RequestTimeoutS
	}
	w := Workload{
		Type:              py.Workload.Type,
		NumRequests:       py.Workload.NumRequests,
		PromptTokens:      py.Workload.PromptTokens,
		PromptTokensStdev: py.Workload.PromptTokensStdev,
		OutputTokens:      py.Workload.OutputTokens,
		OutputTokensStdev: py.Workload.OutputTokensStdev,
		Spec:              py.Workload.Spec,
	}
	if py.Workload.Load != nil {
		w.Load = schema.Load{Kind: py.Workload.Load.Kind, Value: py.Workload.Load.Value}
	}
	p := Profile{
		Name:            py.Name,
		Seed:            py.Seed,
		HorizonTicks:    py.HorizonTicks,
		RequestTimeoutS: timeout,
		Workload:        w,
	}
	if err := Validate(p); err != nil {
		return Profile{}, err
	}
	// The stored hash is provenance; the authoritative one is recomputed. A mismatch
	// means the file was hand-edited inconsistently.
	if py.Workload.SpecSHA256 != nil {
		want, err := schema.SpecSHA256(py.Workload.Spec)
		if err != nil {
			return Profile{}, err
		}
		if *py.Workload.SpecSHA256 != want {
			return Profile{}, fmt.Errorf("spec_sha256 %q does not match the inline spec "+
				"(recomputes to %q); the file was edited inconsistently", *py.Workload.SpecSHA256, want)
		}
	}
	return p, nil
}

// Write emits workloads.yaml with each profile in the clean authored shape: the
// spec_sha256 is computed here so the file always carries a hash consistent with its
// spec.
func (c *Catalog) Write(path string) error {
	f := fileYAML{SchemaVersion: SchemaVersion}
	for _, p := range c.Profiles {
		// A preset is provided by the leaderboard, never persisted, so a merged catalog
		// (Load) written back leaves the file holding only user-authored profiles (§11.2).
		if p.Builtin {
			continue
		}
		wy := workloadYAML{Type: p.Workload.Type}
		switch p.Workload.Type {
		case "distribution":
			wy.NumRequests = p.Workload.NumRequests
			wy.Load = &loadYAML{Kind: p.Workload.Load.Kind, Value: p.Workload.Load.Value}
			wy.PromptTokens = p.Workload.PromptTokens
			wy.PromptTokensStdev = p.Workload.PromptTokensStdev
			wy.OutputTokens = p.Workload.OutputTokens
			wy.OutputTokensStdev = p.Workload.OutputTokensStdev
		case "workload-spec":
			sha, err := schema.SpecSHA256(p.Workload.Spec)
			if err != nil {
				return err
			}
			wy.SpecSHA256 = &sha
			wy.Spec = p.Workload.Spec
		}
		f.Workloads = append(f.Workloads, profileYAML{
			Name:            p.Name,
			Seed:            p.Seed,
			HorizonTicks:    p.HorizonTicks,
			RequestTimeoutS: &p.RequestTimeoutS,
			Workload:        wy,
		})
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(f); err != nil {
		return fmt.Errorf("catalog: encode: %w", err)
	}
	_ = enc.Close()
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("catalog: create %s: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return fmt.Errorf("catalog: write %s: %w", path, err)
	}
	return nil
}

// Group returns the comparability group this profile describes. Model is no longer
// part of the group (E1): it is a candidate supplied per row, so a profile resolves to
// a model-free group. The resolved workload carries the record-shape placeholders for
// the spec variant.
func (p Profile) Group() schema.Group {
	return schema.Group{
		Seed:            p.Seed,
		HorizonTicks:    p.HorizonTicks,
		RequestTimeoutS: p.RequestTimeoutS,
		Workload:        p.Workload.schemaWorkload(),
	}
}

// schemaWorkload resolves the authored workload into the record shape. For the spec
// variant it sets the not-applicable distribution placeholders (mirroring the schema)
// and computes spec_sha256.
func (w Workload) schemaWorkload() schema.Workload {
	if w.Type == "workload-spec" {
		sha, _ := schema.SpecSHA256(w.Spec)
		return schema.Workload{
			Type:           "workload-spec",
			ArrivalProcess: "constant",                // placeholder; arrival lives in the spec
			Load:           schema.Load{Kind: "rate"}, // placeholder; value 0
			SpecSHA256:     &sha,
			Spec:           w.Spec,
		}
	}
	return schema.Workload{
		Type:              "distribution",
		ArrivalProcess:    arrivalProcess(w.Load.Kind),
		NumRequests:       w.NumRequests,
		Load:              w.Load,
		PromptTokens:      w.PromptTokens,
		PromptTokensStdev: w.PromptTokensStdev,
		OutputTokens:      w.OutputTokens,
		OutputTokensStdev: w.OutputTokensStdev,
	}
}

// arrivalProcess reports the process BLIS will actually use, mirroring
// internal/spec.arrivalProcess: rate mode synthesizes a constant process
// (../inference-sim/sim/workload/synthesis.go:33); concurrency mode is closed-loop.
func arrivalProcess(loadKind string) string {
	if loadKind == "concurrency" {
		return "closed-loop"
	}
	return "constant"
}

// contentKey is the profile's canonical content minus name and model: two profiles
// with the same key would produce the same group_id for any given model, so they are
// the same workload under two names (P3).
func (p Profile) contentKey() (string, error) {
	view := struct {
		Seed            int64           `json:"seed"`
		HorizonTicks    *int64          `json:"horizon_ticks"`
		RequestTimeoutS int             `json:"request_timeout_s"`
		Workload        schema.Workload `json:"workload"`
	}{p.Seed, p.HorizonTicks, p.RequestTimeoutS, p.Workload.schemaWorkload()}
	b, err := schema.CanonicalJSON(view)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// FindContentTwin reports an existing profile whose content matches p's but under a
// different name — the P3 twin. A profile with p's own name is not its own twin, so
// editing a profile in place does not trip the check.
func (c *Catalog) FindContentTwin(p Profile) (string, bool) {
	key, err := p.contentKey()
	if err != nil {
		return "", false
	}
	for _, other := range c.Profiles {
		if other.Name == p.Name {
			continue
		}
		otherKey, err := other.contentKey()
		if err != nil {
			continue
		}
		if otherKey == key {
			return other.Name, true
		}
	}
	return "", false
}

// ByName returns the profile with the given name.
func (c *Catalog) ByName(name string) (Profile, bool) {
	for _, p := range c.Profiles {
		if p.Name == name {
			return p, true
		}
	}
	return Profile{}, false
}

// check enforces the catalog-wide invariants: unique name AND unique content (P3).
func (c *Catalog) check() error {
	seenName := map[string]bool{}
	seenContent := map[string]string{} // content key -> first profile name
	for _, p := range c.Profiles {
		if seenName[p.Name] {
			return fmt.Errorf("catalog: duplicate workload name %q", p.Name)
		}
		seenName[p.Name] = true

		key, err := p.contentKey()
		if err != nil {
			return fmt.Errorf("catalog: %s: %w", p.Name, err)
		}
		if prev, ok := seenContent[key]; ok {
			return fmt.Errorf("catalog: %s and %s describe the same workload under two "+
				"names; a workload has one name (P3) — drop one or change a field", prev, p.Name)
		}
		seenContent[key] = p.Name
	}
	return nil
}

var workloadNamePattern = "abcdefghijklmnopqrstuvwxyz0123456789-_."

// Validate checks one profile's well-formedness: a valid name, a variant whose fields
// match its type, and — for the spec variant — a spec that does not pin a model or
// adapter (P6). It does not touch the hardware catalogue or run blis; semantic
// validation of a spec is blis's job (the server's validate endpoint).
func Validate(p Profile) error {
	if p.Name == "" {
		return fmt.Errorf("name is required")
	}
	for _, r := range p.Name {
		if !strings.ContainsRune(workloadNamePattern, r) {
			return fmt.Errorf("name %q has an invalid character %q; use lower-case letters, "+
				"digits, dash, underscore or dot", p.Name, r)
		}
	}
	if p.RequestTimeoutS == 0 {
		return fmt.Errorf("request_timeout_s 0 is rejected by blis; use a positive deadline " +
			"or a negative value to disable it")
	}
	if p.HorizonTicks != nil && *p.HorizonTicks <= 0 {
		return fmt.Errorf("horizon_ticks %d: want > 0 or null", *p.HorizonTicks)
	}

	switch p.Workload.Type {
	case "distribution":
		if p.Workload.Spec != nil {
			return fmt.Errorf("a distribution workload must not carry a spec; set type: " +
				"workload-spec to use one")
		}
		if p.Workload.Load.Kind != "rate" && p.Workload.Load.Kind != "concurrency" {
			return fmt.Errorf("load.kind %q: want \"rate\" or \"concurrency\"", p.Workload.Load.Kind)
		}
		if p.Workload.Load.Value <= 0 {
			return fmt.Errorf("load.value %v: want > 0", p.Workload.Load.Value)
		}
		if p.Workload.NumRequests <= 0 {
			return fmt.Errorf("num_requests %d: want > 0", p.Workload.NumRequests)
		}
		if p.Workload.PromptTokens <= 0 || p.Workload.OutputTokens <= 0 {
			return fmt.Errorf("prompt_tokens and output_tokens must both be > 0")
		}
	case "workload-spec":
		if len(p.Workload.Spec) == 0 {
			return fmt.Errorf("a workload-spec workload requires a non-empty spec")
		}
		if path, pinned := specPinsModel(p.Workload.Spec); pinned {
			return fmt.Errorf("the spec pins a model at %s; the model is chosen in "+
				"Declare-a-run and injected at run time (P6), so remove it to keep this "+
				"workload comparable across models", path)
		}
	default:
		return fmt.Errorf("workload.type %q: want \"distribution\" or \"workload-spec\"", p.Workload.Type)
	}
	return nil
}

// specPinsModel reports the first place a model or adapter is pinned in a WorkloadSpec.
// blis has no top-level model field; model/adapter can only appear per-client or
// per-cohort (upstream sim/workload/spec.go ClientSpec/CohortSpec), so those are the
// only places to check.
func specPinsModel(spec map[string]any) (string, bool) {
	for _, group := range []string{"clients", "cohorts"} {
		list, ok := spec[group].([]any)
		if !ok {
			continue
		}
		for i, el := range list {
			m, ok := el.(map[string]any)
			if !ok {
				continue
			}
			for _, field := range []string{"model", "adapter"} {
				if v, ok := m[field]; ok {
					if s, ok := v.(string); ok && s != "" {
						return fmt.Sprintf("%s[%d].%s", group, i, field), true
					}
				}
			}
		}
	}
	return "", false
}

// Names returns the profile names in sorted order, for messages and listings.
func (c *Catalog) Names() []string {
	names := make([]string, 0, len(c.Profiles))
	for _, p := range c.Profiles {
		names = append(names, p.Name)
	}
	sort.Strings(names)
	return names
}
