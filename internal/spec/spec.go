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
	// runs.yaml authors the flat gaussian shorthand only, still spelled `type:
	// distribution` for backward compatibility. It is not a stored variant: it is lowered
	// into a one-client workload-spec here (synthesizeGaussianSpec), exactly as blis lowers
	// `--workload distribution` internally, so the stored record is always a workload-spec.
	if g.Workload.Type != "distribution" {
		return schema.Group{}, fmt.Errorf(
			"spec: workload.type %q: runs.yaml authors the flat gaussian shorthand only, "+
				"written as `type: distribution` (it is lowered to a one-client workload-spec "+
				"before the run). The \"workload-spec\" and \"trace\" variants carry an inline "+
				"spec or a multi-MB trace blob that a runs.yaml cannot; run them with "+
				"`leaderboard serve` and the Declare-a-run form", g.Workload.Type)
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
	if g.Workload.PromptTokens <= 0 || g.Workload.OutputTokens <= 0 {
		return schema.Group{}, fmt.Errorf("spec: prompt_tokens and output_tokens must both be > 0")
	}
	if g.Workload.PromptTokensStdev < 0 || g.Workload.OutputTokensStdev < 0 {
		return schema.Group{}, fmt.Errorf("spec: prompt_tokens_stdev and output_tokens_stdev must be >= 0")
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

	spec := synthesizeGaussianSpec(g.Workload)
	sha, err := schema.SpecSHA256(spec)
	if err != nil {
		return schema.Group{}, fmt.Errorf("spec: hash synthesized workload-spec: %w", err)
	}

	return schema.Group{
		Seed:            g.Seed,
		HorizonTicks:    g.HorizonTicks,
		RequestTimeoutS: timeout,
		// The record is a workload-spec: the flat fields are the not-applicable placeholder
		// zeros every spec record carries, and arrival_process holds the "constant"
		// placeholder (the real arrival is inside the spec). This matches
		// catalog.schemaWorkload, so a flat workload authored in runs.yaml and the same one
		// authored in the web catalog resolve to byte-identical group_ids.
		Workload: schema.Workload{
			Type:           "workload-spec",
			ArrivalProcess: "constant",
			Load:           schema.Load{Kind: "rate"},
			SpecSHA256:     &sha,
			Spec:           spec,
		},
	}, nil
}

// synthesizeGaussianSpec lowers the flat gaussian shorthand into the one-client
// WorkloadSpec blis itself builds from `--workload distribution`
// (../inference-sim/sim/workload/synthesis.go, SynthesizeFromDistribution): a single
// language client, constant arrival, gaussian token distributions. The token min/max are
// blis's --prompt-tokens-min/max and --output-tokens-min/max flag defaults — 2 and 7000
// (../inference-sim/cmd/root.go:45-50) — which the flat path used because the leaderboard
// never passed those flags, so the synthesized spec reproduces the exact request stream
// the flat form produced at a given seed. Mirrored, not imported: inference-sim is a
// read-only upstream module. The client id is a label only (blis seeds per-client sampling
// from draw order, not the id: ../inference-sim/sim/workload/generator.go:74), so "c0"
// matches the preset and catalog convention without changing the stream.
func synthesizeGaussianSpec(w workloadSpec) map[string]any {
	const tokenMin, tokenMax = 2.0, 7000.0
	gaussian := func(mean, stdev int) map[string]any {
		return map[string]any{
			"type": "gaussian",
			"params": map[string]any{
				"mean":    float64(mean),
				"std_dev": float64(stdev),
				"min":     tokenMin,
				"max":     tokenMax,
			},
		}
	}
	client := map[string]any{
		"id":                  "c0",
		"arrival":             map[string]any{"process": "constant"},
		"input_distribution":  gaussian(w.PromptTokens, w.PromptTokensStdev),
		"output_distribution": gaussian(w.OutputTokens, w.OutputTokensStdev),
	}
	spec := map[string]any{
		"version":      "2",
		"category":     "language",
		"num_requests": w.NumRequests,
		"clients":      []any{client},
	}
	// Rate mode carries the open-loop rate on the spec and gives the sole client the whole
	// of it; concurrency mode is closed-loop, the client holding the session pool size.
	if w.Load.Kind == "concurrency" {
		client["concurrency"] = w.Load.Value
	} else {
		spec["aggregate_rate"] = w.Load.Value
		client["rate_fraction"] = 1.0
	}
	return spec
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
