// Package blisrun turns a declared run into a blis invocation and back into a
// record. Nothing here interprets the simulation; that lives upstream.
package blisrun

import (
	"sort"
	"strconv"
	"strings"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// Cwd is the working directory blis must be run from: it resolves defaults.yaml,
// hardware_config.json, and the model_configs/ cache relative to cwd, and fails or
// silently mis-defaults otherwise.
const Cwd = "../inference-sim"

// The blis defaults for the PD KV-transfer physics (cmd/root.go). A disaggregated run
// emits these flags only when it deviates from them, so the argv stays minimal.
const (
	defaultPDTransferBandwidth   = 25.0
	defaultPDTransferBaseLatency = 0.05
)

// Argv builds the command line for one run. It is a pure function of the declared
// inputs, so a distribution argv stored in a record reproduces the record. specPath is
// the file the inline WorkloadSpec was materialized to; it is used only for the
// workload-spec variant and ignored otherwise (a spec run's argv carries that path, so
// it reproduces from the record's inline spec re-materialized, not from the path
// verbatim).
func Argv(binary string, g schema.Group, d schema.Deployment, metricsPath, specPath string) []string {
	a := []string{binary, "run"}
	add := func(flag, value string) { a = append(a, flag, value) }

	add("--model", d.Model)
	add("--hardware", d.Hardware)
	add("--tp", strconv.Itoa(d.TP))
	// --dp is MoE-only upstream and rejects several combinations, so the default is
	// left off rather than asserted.
	if d.DP > 1 {
		add("--dp", strconv.Itoa(d.DP))
	}
	// The MoE knobs, emitted only when on: --enable-expert-parallel is a valueless bool
	// flag, and --moe-comm-backend is left off when unset. blis fatally rejects either on
	// a dense model, so the form guards them, but the argv only reflects what was set.
	if d.EnableExpertParallel {
		a = append(a, "--enable-expert-parallel")
	}
	if d.MoECommBackend != "" {
		add("--moe-comm-backend", d.MoECommBackend)
	}
	add("--num-instances", strconv.Itoa(d.NumInstances))

	// Prefill/decode disaggregation, present only when a pool is declared. Each flag is
	// emitted only when it carries a non-default value (the --dp
	// precedent), so a disaggregated run at blis's transfer defaults stays terse and a
	// non-disaggregated run emits none of this.
	if pd := d.Disaggregation; pd != nil {
		if pd.PrefillInstances > 0 {
			add("--prefill-instances", strconv.Itoa(pd.PrefillInstances))
		}
		if pd.DecodeInstances > 0 {
			add("--decode-instances", strconv.Itoa(pd.DecodeInstances))
		}
		if pd.PrefillDecodeInstances > 0 {
			add("--prefill-decode-instances", strconv.Itoa(pd.PrefillDecodeInstances))
		}
		// The decider drives disaggregation; "never" is blis's default and is left off.
		if pd.Decider != "" && pd.Decider != "never" {
			add("--pd-decider", pd.Decider)
		}
		// The threshold only means anything to the prefix-threshold decider (blis warns
		// otherwise), so it rides with it.
		if pd.Decider == "prefix-threshold" {
			add("--pd-prefix-threshold", strconv.Itoa(pd.PrefixThreshold))
		}
		if pd.TransferBandwidth != defaultPDTransferBandwidth {
			add("--pd-transfer-bandwidth", strconv.FormatFloat(pd.TransferBandwidth, 'f', -1, 64))
		}
		if pd.TransferBaseLatency != defaultPDTransferBaseLatency {
			add("--pd-transfer-base-latency", strconv.FormatFloat(pd.TransferBaseLatency, 'f', -1, 64))
		}
		if pd.TransferContention {
			a = append(a, "--pd-transfer-contention")
		}
	}

	// The workload surface: either the synthetic distribution flags, or a spec file
	// that supersedes them (upstream: --workload-spec "overrides --workload", and the
	// synthetic --rate/--prompt-tokens/… flags are read only on the synthesize path).
	if g.Workload.Type == "workload-spec" {
		add("--workload-spec", specPath)
	} else {
		add("--workload", g.Workload.Type)
		add("--num-requests", strconv.Itoa(g.Workload.NumRequests))
		// Exactly one of these: upstream rejects --rate together with --concurrency.
		if g.Workload.Load.Kind == "concurrency" {
			add("--concurrency", strconv.FormatFloat(g.Workload.Load.Value, 'f', -1, 64))
		} else {
			add("--rate", strconv.FormatFloat(g.Workload.Load.Value, 'f', -1, 64))
		}
	}

	// Group-side knobs. blis lets --seed/--timeout/--horizon override the spec's own
	// values, and these decide whether the declared work completes, so they are passed
	// in both variants.
	add("--seed", strconv.FormatInt(g.Seed, 10))
	add("--timeout", strconv.Itoa(g.RequestTimeoutS))
	if g.HorizonTicks != nil {
		add("--horizon", strconv.FormatInt(*g.HorizonTicks, 10))
	}

	if g.Workload.Type != "workload-spec" {
		add("--prompt-tokens", strconv.Itoa(g.Workload.PromptTokens))
		add("--prompt-tokens-stdev", strconv.Itoa(g.Workload.PromptTokensStdev))
		add("--output-tokens", strconv.Itoa(g.Workload.OutputTokens))
		add("--output-tokens-stdev", strconv.Itoa(g.Workload.OutputTokensStdev))
	}

	if d.MaxModelLen > 0 {
		add("--max-model-len", strconv.FormatInt(d.MaxModelLen, 10))
	}
	add("--block-size-in-tokens", strconv.FormatInt(d.BlockSizeInTokens, 10))
	add("--max-num-seqs", strconv.FormatInt(d.MaxNumSeqs, 10))
	// Upstream deprecated --max-num-scheduled-tokens in favour of this spelling;
	// both write the same variable.
	add("--max-num-batched-tokens", strconv.FormatInt(d.MaxNumBatchedTokens, 10))

	add("--long-prefill-token-threshold", strconv.FormatInt(d.LongPrefillTokenThreshold, 10))

	add("--scheduler", d.Scheduler)
	add("--preemption-policy", d.PreemptionPolicy)
	add("--routing-policy", d.RoutingPolicy)
	// --routing-scorers is the weighted policy's name:weight profile, and blis reads it
	// only for that policy (it warns and ignores it otherwise). So it is emitted only when
	// the policy is "weighted" and a profile is present — the same "emit only when the
	// capability is on" rule as --dp and the speculative trio, which keeps a non-weighted
	// record's argv byte-for-byte unchanged.
	if d.RoutingPolicy == "weighted" && len(d.RoutingScorers) > 0 {
		pairs := make([]string, len(d.RoutingScorers))
		for i, s := range d.RoutingScorers {
			pairs[i] = s.Name + ":" + strconv.FormatFloat(s.Weight, 'f', -1, 64)
		}
		add("--routing-scorers", strings.Join(pairs, ","))
	}
	add("--admission-policy", d.AdmissionPolicy)
	add("--kv-cache-dtype", d.KVCacheDtype)
	add("--latency-model", d.LatencyModel)

	add("--gpu-memory-utilization", strconv.FormatFloat(d.GPUMemoryUtilization, 'f', -1, 64))

	// The speculative trio follows the --dp precedent: emitted only when the capability
	// is on. blis requires --speculative-acceptance-rate when K>0 and rejects a
	// --speculative-method (or a non-zero acceptance rate) when K==0, so an off run
	// passes none of them and reproduces from the record's stored defaults.
	if d.NumSpeculativeTokens > 0 {
		add("--num-speculative-tokens", strconv.Itoa(d.NumSpeculativeTokens))
		add("--speculative-acceptance-rate", strconv.FormatFloat(d.SpeculativeAcceptanceRate, 'f', -1, 64))
		if d.SpeculativeMethod != "" {
			add("--speculative-method", d.SpeculativeMethod)
		}
	}

	keys := make([]string, 0, len(d.ExtraFlags))
	for k := range d.ExtraFlags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		add("--"+k, d.ExtraFlags[k])
	}

	// Required, and last so it is easy to find in a stored argv: cache_hit_rate and
	// requests[] are written only to the file branch of EmitOutput.
	add("--metrics-path", metricsPath)
	return a
}
