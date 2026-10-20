// Package blisrun turns a declared run into a blis invocation and back into a
// record. Nothing here interprets the simulation; that lives upstream.
package blisrun

import (
	"sort"
	"strconv"
	"strings"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// Cwd is the working directory blis is run from. Since v0.10.0 blis resolves the catalog,
// registry and scenarios from explicit flags (absolute paths), so cwd no longer picks the
// model/hardware config; but it still carries defaults.yaml and is the checkout
// GitProvenance shells `git` in, so a run is executed from it.
const Cwd = "../inference-sim"

// Argv builds the command line for one workload-spec run. It is a pure function of the
// declared inputs plus the resolved paths (the generated scenario, the registry/catalog
// clones), so a stored argv reproduces the record given those paths. The deployment's
// model/hardware/parallelism and engine knobs live in the scenario file (scenariosDir +
// scenarioFile); only the scheduling/routing/admission knobs remain CLI flags.
func Argv(binary, scenariosDir, scenarioFile, registry, catalog string, g schema.Group, d schema.Deployment, metricsPath, specPath, kvOffloadPath string) []string {
	a := []string{binary, "run"}
	add := func(flag, value string) { a = append(a, flag, value) }

	a = appendScenario(a, scenariosDir, scenarioFile, registry, catalog)

	// The workload surface is the inline spec: --workload-spec supersedes the synthetic
	// flags entirely (upstream: it "overrides --workload").
	add("--workload-spec", specPath)

	// Group-side knobs. blis lets --seed/--timeout/--horizon override the spec's own
	// values, and these decide whether the declared work completes.
	add("--seed", strconv.FormatInt(g.Seed, 10))
	add("--timeout", strconv.Itoa(g.RequestTimeoutS))
	if g.HorizonTicks != nil {
		add("--horizon", strconv.FormatInt(*g.HorizonTicks, 10))
	}

	a = appendCandidateHead(a, d)
	a = appendCandidateTail(a, d)

	if d.KVOffload != nil {
		add("--kv-offload-config", kvOffloadPath)
	}

	add("--metrics-path", metricsPath)
	return a
}

// ReplayArgv builds the command line for a trace replay. It shares the scenario and the
// candidate-flag blocks with Argv so a candidate is spelled identically whether run or
// replayed, and emits the trace + injection flags in place of the synthetic ones.
func ReplayArgv(binary, scenariosDir, scenarioFile, registry, catalog string, g schema.Group, d schema.Deployment, metricsPath, traceHeader, traceData, kvOffloadPath string) []string {
	a := []string{binary, "replay"}
	add := func(flag, value string) { a = append(a, flag, value) }

	a = appendScenario(a, scenariosDir, scenarioFile, registry, catalog)

	add("--trace-header", traceHeader)
	add("--trace-data", traceData)

	// The trace is guaranteed present for a trace workload; guard anyway so a malformed
	// record produces a terse argv rather than a nil dereference.
	if t := g.Workload.Trace; t != nil {
		add("--session-mode", t.SessionMode)
		if t.ThinkTimeMs > 0 {
			add("--think-time-ms", strconv.Itoa(t.ThinkTimeMs))
		}
		if t.ThinkTimeDist != "" {
			add("--think-time-dist", t.ThinkTimeDist)
		}
		if t.ConcurrentSessions > 0 {
			add("--concurrent-sessions", strconv.Itoa(t.ConcurrentSessions))
			if t.TotalSessions > 0 {
				add("--total-sessions", strconv.Itoa(t.TotalSessions))
			}
			if t.ShuffleCorpus {
				a = append(a, "--shuffle-corpus")
			}
		}
	}

	a = appendCandidateHead(a, d)
	a = appendCandidateTail(a, d)

	if d.KVOffload != nil {
		add("--kv-offload-config", kvOffloadPath)
	}

	add("--seed", strconv.FormatInt(g.Seed, 10))
	// No --timeout: blis replay does not register it (run-only). A horizon is passed only
	// when the group declares one, as on a run.
	if g.HorizonTicks != nil {
		add("--horizon", strconv.FormatInt(*g.HorizonTicks, 10))
	}

	add("--metrics-path", metricsPath)
	return a
}

// appendScenario emits the four flags that locate the deployment and its pricing inputs:
// the generated scenario (a dir plus the file within it) and the catalog + registry
// clones. Absolute paths, since blis runs from Cwd and resolves these with no search path.
func appendScenario(a []string, scenariosDir, scenarioFile, registry, catalog string) []string {
	return append(a, "--scenarios", scenariosDir, "--scenario", scenarioFile, "--registry", registry, "--catalog", catalog)
}

// appendCandidateHead emits the leading candidate CLI flags that survive v0.10.0. Model,
// hardware, tp/dp, expert parallelism and disaggregation now live in the scenario file (or
// are refused by scenario.Generate), so only the instance count remains here.
func appendCandidateHead(a []string, d schema.Deployment) []string {
	return append(a, "--num-instances", strconv.Itoa(d.NumInstances))
}

// appendCandidateTail emits the trailing candidate CLI flags that survive v0.10.0 — the
// scheduling, routing, admission and chunked-prefill knobs, plus the extra-flags escape
// hatch. The engine knobs (block size, batch/seq caps, model length, KV dtype, GPU
// memory) moved into the scenario's engine block; --latency-model and the speculative/
// total-kv-blocks flags were removed upstream (scenario.Generate refuses the latter).
func appendCandidateTail(a []string, d schema.Deployment) []string {
	add := func(flag, value string) { a = append(a, flag, value) }

	add("--long-prefill-token-threshold", strconv.FormatInt(d.LongPrefillTokenThreshold, 10))
	add("--scheduler", d.Scheduler)
	add("--preemption-policy", d.PreemptionPolicy)
	add("--routing-policy", d.RoutingPolicy)
	// --routing-scorers is read only for the weighted policy; emitted only then, so a
	// non-weighted record's argv is byte-for-byte unchanged.
	if d.RoutingPolicy == "weighted" && len(d.RoutingScorers) > 0 {
		pairs := make([]string, len(d.RoutingScorers))
		for i, s := range d.RoutingScorers {
			pairs[i] = s.Name + ":" + strconv.FormatFloat(s.Weight, 'f', -1, 64)
		}
		add("--routing-scorers", strings.Join(pairs, ","))
	}
	add("--admission-policy", d.AdmissionPolicy)

	keys := make([]string, 0, len(d.ExtraFlags))
	for k := range d.ExtraFlags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		add("--"+k, d.ExtraFlags[k])
	}
	return a
}
