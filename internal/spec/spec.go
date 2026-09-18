// Package spec reads runs.yaml: the authored declaration of one comparability
// group and the candidates to run against it. Inputs are authored, never inferred
// (D1), so every mistake here is worth catching before a single blis process
// starts.
package spec

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/hardware"
	"github.com/inference-sim/leaderboard/internal/schema"
)

// defaultRequestTimeoutS mirrors --timeout's upstream default (cmd/root.go:3149).
const defaultRequestTimeoutS = 300

var runIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// Plan is a loaded runs.yaml: one group, N candidates.
type Plan struct {
	Group schema.Group
	Runs  []Candidate
}

// Candidate is one row of one table.
type Candidate struct {
	RunID      string
	Deployment schema.Deployment
}

type file struct {
	SchemaVersion int              `yaml:"schema_version"`
	Group         groupSpec        `yaml:"group"`
	Defaults      map[string]any   `yaml:"defaults"`
	Runs          []map[string]any `yaml:"runs"`
}

type groupSpec struct {
	Seed            int64        `yaml:"seed"`
	HorizonTicks    *int64       `yaml:"horizon_ticks"`
	RequestTimeoutS *int         `yaml:"request_timeout_s"`
	Workload        workloadSpec `yaml:"workload"`
}

type workloadSpec struct {
	Type              string   `yaml:"type"`
	NumRequests       int      `yaml:"num_requests"`
	Load              loadSpec `yaml:"load"`
	PromptTokens      int      `yaml:"prompt_tokens"`
	PromptTokensStdev int      `yaml:"prompt_tokens_stdev"`
	OutputTokens      int      `yaml:"output_tokens"`
	OutputTokensStdev int      `yaml:"output_tokens_stdev"`
	SpecFile          *string  `yaml:"spec_file"`
}

type loadSpec struct {
	Kind  string  `yaml:"kind"`
	Value float64 `yaml:"value"`
}

// blisDefaults are the deployment values BLIS itself uses when a flag is omitted,
// read from ../inference-sim/cmd/root.go. Every field is written into every record
// even when it holds a default, so canonicalisation is stable and the UI can tell
// which fields vary across a group.
func blisDefaults() schema.Deployment {
	return schema.Deployment{
		DP:                        1,
		NumInstances:              1,
		MaxModelLen:               0, // 0 = unlimited; blis auto-derives from the HF config
		BlockSizeInTokens:         16,
		MaxNumSeqs:                256,
		MaxNumBatchedTokens:       2048,
		LongPrefillTokenThreshold: 0, // 0 = off; blis accepts it
		Scheduler:                 "fcfs",
		PreemptionPolicy:          "fcfs",
		RoutingPolicy:             "round-robin",
		AdmissionPolicy:           "always-admit",
		KVCacheDtype:              "auto",
		LatencyModel:              "trained-physics",
		GPUMemoryUtilization:      0.9,
		NumSpeculativeTokens:      0,   // off; the acceptance rate and method stay unset
		SpeculativeAcceptanceRate: 0.0, // only meaningful when NumSpeculativeTokens > 0
		SpeculativeMethod:         "",
		ExtraFlags:                map[string]string{},
	}
}

// Load parses runs.yaml, merges each candidate over the declared defaults over
// BLIS's defaults, and fills the derived fields.
func Load(path string) (*Plan, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("spec: read %s: %w", path, err)
	}

	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true) // a typo in a group field is an error, not a silent default
	var f file
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("spec: parse %s: %w", path, err)
	}

	if f.SchemaVersion != schema.SchemaVersion {
		return nil, fmt.Errorf("spec: schema_version %d, this build reads %d",
			f.SchemaVersion, schema.SchemaVersion)
	}
	group, err := buildGroup(f.Group)
	if err != nil {
		return nil, err
	}
	if len(f.Runs) == 0 {
		return nil, fmt.Errorf("spec: %s declares no runs", path)
	}

	plan := &Plan{Group: group}
	seenID := map[string]bool{}
	for i, entry := range f.Runs {
		cand, err := buildCandidate(entry, f.Defaults)
		if err != nil {
			return nil, fmt.Errorf("spec: runs[%d]: %w", i, err)
		}
		if seenID[cand.RunID] {
			return nil, fmt.Errorf("spec: duplicate run_id %q", cand.RunID)
		}
		seenID[cand.RunID] = true
		plan.Runs = append(plan.Runs, cand)
	}
	return plan, nil
}

func buildGroup(g groupSpec) (schema.Group, error) {
	if g.Workload.Type != "distribution" {
		return schema.Group{}, fmt.Errorf(
			"spec: workload.type %q: only \"distribution\" is supported; --workload-spec "+
				"is reserved in the schema but not implemented", g.Workload.Type)
	}
	if g.Workload.SpecFile != nil {
		return schema.Group{}, fmt.Errorf(
			"spec: workload.spec_file is reserved but not implemented; remove it")
	}
	if g.Workload.Load.Kind != "rate" && g.Workload.Load.Kind != "concurrency" {
		return schema.Group{}, fmt.Errorf(
			"spec: workload.load.kind %q: want \"rate\" or \"concurrency\"", g.Workload.Load.Kind)
	}
	if g.Workload.Load.Value <= 0 {
		return schema.Group{}, fmt.Errorf("spec: workload.load.value %v: want > 0", g.Workload.Load.Value)
	}
	if g.Workload.NumRequests <= 0 {
		return schema.Group{}, fmt.Errorf("spec: workload.num_requests %d: want > 0", g.Workload.NumRequests)
	}
	if g.HorizonTicks != nil && *g.HorizonTicks <= 0 {
		return schema.Group{}, fmt.Errorf("spec: horizon_ticks %d: want > 0 or null", *g.HorizonTicks)
	}

	timeout := defaultRequestTimeoutS
	if g.RequestTimeoutS != nil {
		if *g.RequestTimeoutS == 0 {
			return schema.Group{}, fmt.Errorf("spec: request_timeout_s 0 is rejected by blis; " +
				"use a positive deadline or a negative value to disable it")
		}
		timeout = *g.RequestTimeoutS
	}

	return schema.Group{
		Seed:            g.Seed,
		HorizonTicks:    g.HorizonTicks,
		RequestTimeoutS: timeout,
		Workload: schema.Workload{
			Type: g.Workload.Type,
			// Derived, not authored: an author cannot mislabel the arrival process.
			ArrivalProcess:    arrivalProcess(g.Workload.Load.Kind),
			NumRequests:       g.Workload.NumRequests,
			Load:              schema.Load{Kind: g.Workload.Load.Kind, Value: g.Workload.Load.Value},
			PromptTokens:      g.Workload.PromptTokens,
			PromptTokensStdev: g.Workload.PromptTokensStdev,
			OutputTokens:      g.Workload.OutputTokens,
			OutputTokensStdev: g.Workload.OutputTokensStdev,
		},
	}, nil
}

// arrivalProcess reports the process BLIS will actually use.
// SynthesizeFromDistribution sets ArrivalSpec{Process: "constant"} in both modes
// (../inference-sim/sim/workload/synthesis.go:33); concurrency mode is closed-loop,
// where sessions rather than a clock drive arrival.
func arrivalProcess(loadKind string) string {
	if loadKind == "concurrency" {
		return "closed-loop"
	}
	return "constant"
}

func buildCandidate(entry, defaults map[string]any) (Candidate, error) {
	merged := map[string]any{}
	maps.Copy(merged, defaults)
	var runID string
	for k, v := range entry {
		if k == "run_id" {
			s, ok := v.(string)
			if !ok {
				return Candidate{}, fmt.Errorf("run_id must be a string, got %T", v)
			}
			runID = s
			continue
		}
		merged[k] = v
	}
	if runID == "" {
		return Candidate{}, fmt.Errorf("missing run_id")
	}
	if !runIDPattern.MatchString(runID) {
		return Candidate{}, fmt.Errorf("run_id %q must match %s (it is also a filename)",
			runID, runIDPattern)
	}

	// Round-trip through JSON so the deployment is decoded by the same tags the
	// record is written with, and an unknown key is an error rather than a
	// silently-ignored typo.
	body, err := json.Marshal(merged)
	if err != nil {
		return Candidate{}, fmt.Errorf("%s: encode deployment: %w", runID, err)
	}
	d := blisDefaults()
	jd := json.NewDecoder(bytes.NewReader(body))
	jd.DisallowUnknownFields()
	if err := jd.Decode(&d); err != nil {
		return Candidate{}, fmt.Errorf("%s: %w", runID, err)
	}
	if d.ExtraFlags == nil {
		d.ExtraFlags = map[string]string{}
	}

	if d.Hardware == "" {
		return Candidate{}, fmt.Errorf("%s: hardware is required; the trained-physics "+
			"backend refuses to run without it and omitting it silently defaults to H100", runID)
	}
	if d.TP <= 0 {
		return Candidate{}, fmt.Errorf("%s: tp is required and must be > 0; omitting it "+
			"silently defaults to 1", runID)
	}
	// Model is a candidate field now (E1), so it is validated here rather than on the
	// group. The org-prefix rule is unchanged: a model has one canonical org-prefixed
	// spelling (that is how defaults.yaml is keyed), so a mis-spelling cannot split a
	// single candidate into two.
	if !strings.Contains(d.Model, "/") {
		return Candidate{}, fmt.Errorf(
			"%s: model %q must be org-prefixed (e.g. qwen/qwen3-14b): that is how "+
				"defaults.yaml is keyed, and it gives a model one canonical spelling", runID, d.Model)
	}
	return Candidate{RunID: runID, Deployment: d}, nil
}

// Check validates a plan against the hardware catalogue and against itself. It is
// separate from Load because it needs the upstream catalogue, which a pure parsing
// test should not.
func Check(p *Plan, cat *hardware.Catalog) error {
	seenID := map[string]bool{}
	seenDeployment := map[string]string{} // canonical deployment -> run_id
	seenHardware := map[string]string{}   // hardware name -> run_id

	for _, c := range p.Runs {
		if prev := seenID[c.RunID]; prev {
			return fmt.Errorf("spec: duplicate run_id %q", c.RunID)
		}
		seenID[c.RunID] = true

		if !cat.Known(c.Deployment.Hardware) {
			return fmt.Errorf("spec: %s: hardware %q is not in hardware_config.json; "+
				"valid names are %s", c.RunID, c.Deployment.Hardware,
				strings.Join(cat.Names(), ", "))
		}

		key, err := schema.CanonicalJSON(c.Deployment)
		if err != nil {
			return fmt.Errorf("spec: %s: canonicalise deployment: %w", c.RunID, err)
		}
		if prev, ok := seenDeployment[string(key)]; ok {
			return fmt.Errorf("spec: %s and %s declare identical deployments, so they "+
				"would be two rows differing invisibly (A3); drop one or change a knob",
				prev, c.RunID)
		}
		seenDeployment[string(key)] = c.RunID

		for _, alias := range cat.Aliases(c.Deployment.Hardware) {
			if prev, ok := seenHardware[alias]; ok {
				return fmt.Errorf("spec: %s uses %q and %s uses %q, which "+
					"hardware_config.json defines with identical specs — they are an "+
					"alias pair, so this is a duplicate row rather than a second candidate",
					c.RunID, c.Deployment.Hardware, prev, alias)
			}
		}
		seenHardware[c.Deployment.Hardware] = c.RunID
	}
	return nil
}
