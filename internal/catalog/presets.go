package catalog

// The built-in workload presets (design §11). BLIS ships four named presets —
// chatbot, contentgen, summarization, multidoc — as convenience token-shape templates
// (SynthesizeFromPreset). The leaderboard exposes them as read-only profiles so the
// same starting points exist on every instance, independent of the local, gitignored
// workloads.yaml (B1).
//
// Each is stored as a workload-spec (B3): the preset's token min/max clamps are an
// expanded Tier-1 field the flat distribution variant cannot express. BLIS presets are
// load-agnostic (rate/count come from --rate/--num-requests), but a leaderboard profile
// is a complete comparability group and a workload-spec run passes neither flag, so each
// preset binds its canonical offered load — aggregate_rate + num_requests — inside the
// spec (B4). The group seed (42) overrides the spec's, so the spec carries no seed.

// presetNumRequests matches runs.yaml's request count so the presets are comparable in
// scale with the committed distribution tables.
const presetNumRequests = 500

// gaussian is one clamped gaussian token distribution, the only distribution family the
// presets use (faithful to SynthesizeFromPreset). BLIS's gaussian requires
// mean/std_dev/min/max (../inference-sim/sim/workload/distribution.go:230).
func gaussian(mean, stdDev, min, max float64) map[string]any {
	return map[string]any{
		"type":   "gaussian",
		"params": map[string]any{"mean": mean, "std_dev": stdDev, "min": min, "max": max},
	}
}

// presetSpec builds the canonical single-client WorkloadSpec for a preset (§11.3): one
// open-loop, constant-arrival, language client carrying the whole offered load.
func presetSpec(aggregateRate float64, input, output map[string]any) map[string]any {
	return map[string]any{
		"version":        "2",
		"category":       "language",
		"aggregate_rate": aggregateRate,
		"num_requests":   presetNumRequests,
		"clients": []any{
			map[string]any{
				"id":                  "c0",
				"rate_fraction":       1.0,
				"arrival":             map[string]any{"process": "constant"},
				"input_distribution":  input,
				"output_distribution": output,
			},
		},
	}
}

// preset assembles one read-only profile with the group knobs every preset shares.
func preset(name string, spec map[string]any) Profile {
	return Profile{
		Name:            name,
		Seed:            42,
		HorizonTicks:    nil,
		RequestTimeoutS: defaultRequestTimeoutS,
		Builtin:         true,
		Workload:        Workload{Type: "workload-spec", Spec: spec},
	}
}

// Presets returns the four built-in workload profiles, constructed in Go (never parsed
// from a file). The per-preset rate is scaled to token weight so a heavy-context preset
// is not offered an unsustainable rate (§11.3). The returned slice is freshly built on
// each call, so a caller may append to it.
func Presets() []Profile {
	return []Profile{
		preset("chatbot", presetSpec(10,
			gaussian(256, 100, 2, 800),
			gaussian(256, 100, 1, 1024))),
		preset("contentgen", presetSpec(6,
			gaussian(1024, 150, 10, 2048),
			gaussian(1024, 200, 10, 2048))),
		preset("summarization", presetSpec(4,
			gaussian(4096, 500, 100, 8192),
			gaussian(512, 150, 10, 2048))),
		preset("multidoc", presetSpec(2,
			gaussian(10240, 1200, 500, 20480),
			gaussian(1536, 300, 50, 4096))),
	}
}
