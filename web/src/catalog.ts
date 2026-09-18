/**
 * Snapshots of upstream facts the form needs to offer choices. This screen is
 * pure front-end — it emits a declaration for the CLI to run rather than running
 * blis itself — so the option lists cannot be read from the simulator at request
 * time and are committed here instead.
 *
 * Refresh with, from this repo's root:
 *
 *   python3 -c "import json;print(list(json.load(open('../inference-sim/hardware_config.json'))))"
 *   ls ../inference-sim/model_configs/
 *
 * Last checked against ../inference-sim @ 07622594 on 2026-09-16.
 */

export interface HardwareOption {
  name: string
  /**
   * Set when hardware_config.json defines this name with specs identical to
   * another entry. An alias is a duplicate row rather than a second candidate, so
   * `internal/spec.Check` rejects a group holding both — the form says so before
   * the CLI has to.
   */
  aliasOf?: string
}

export const HARDWARE: HardwareOption[] = [
  { name: 'H100' },
  { name: 'A100-SXM' },
  { name: 'A100-80', aliasOf: 'A100-SXM' },
  { name: 'L40S' },
]

/**
 * The accelerators the picker offers: the canonical entries only. An alias (A100-80, which
 * hardware_config.json defines with the same specs as A100-SXM) is the same accelerator, not
 * a second choice, so it is not a separate button. It stays in HARDWARE as the alias metadata
 * aliasesOf() reads, so a record filed under the alias name — e.g. one declared through the
 * CLI — is still recognized as a duplicate row rather than a rival.
 */
export const SELECTABLE_HARDWARE = HARDWARE.filter((hw) => !hw.aliasOf)

/** The two names that collide, in both directions. */
export function aliasesOf(name: string): string[] {
  const out: string[] = []
  for (const hw of HARDWARE) {
    if (hw.name === name && hw.aliasOf) out.push(hw.aliasOf)
    if (hw.aliasOf === name) out.push(hw.name)
  }
  return out
}

/** Tensor-parallel widths worth offering as one click. Any integer is legal. */
export const TP_CHOICES = [1, 2, 4, 8, 16, 32, 64]

/**
 * The four built-in workload presets BLIS ships (workload-profiles design §11). Their
 * names are reserved: a saved profile whose name collides with a preset is rejected
 * (P3/B2), so a record whose workload_name is one of these was declared with the preset.
 * The board uses this only to tag a card "preset"; the presets themselves stay
 * server-provided (inlining them client-side is a non-goal, §7).
 */
export const PRESET_NAMES = ['chatbot', 'contentgen', 'summarization', 'multidoc']

/**
 * The closed sets of names blis accepts for the serving knobs the candidate form
 * exposes. Each mirrors a `--flag` registered in ../inference-sim/cmd/root.go; blis
 * fails fast (logrus.Fatalf) on a value outside its set, so offering only these keeps
 * the form from declaring a run the simulator would refuse. The leaderboard's own
 * validation (internal/spec) does not check these; it decodes them and lets blis
 * judge, so this list is the only guard the form has, and it is worth keeping current.
 *
 * Refresh with, from this repo's root:
 *
 *   grep -n 'scheduler\|preemption-policy\|routing-policy\|admission-policy\|kv-cache-dtype\|latency-model' ../inference-sim/cmd/root.go
 *
 * Last checked against ../inference-sim @ 07622594 on 2026-09-17.
 */
export const SCHEDULERS = ['fcfs', 'priority-fcfs', 'sjf', 'reverse-priority']
export const PREEMPTION_POLICIES = ['fcfs', 'priority']
export const ROUTING_POLICIES = ['round-robin', 'least-loaded', 'weighted', 'always-busiest']

/**
 * The scorers the "weighted" routing policy blends, each with a weight (--routing-scorers,
 * a comma-separated name:weight profile). blis reads this only for the weighted policy and
 * warns otherwise. The names are sim.ValidScorerNames; the defaults are its
 * DefaultScorerConfigs, the profile blis applies when weighted with none given, so the form
 * seeds them and a run always spells the profile out rather than leaning on that fallback.
 *
 * Refresh with, from this repo's root:
 *
 *   grep -n 'validScorerNames\|DefaultScorerConfigs' ../inference-sim/sim/routing_scorers.go
 *
 * Last checked against ../inference-sim @ 07622594 on 2026-09-17.
 */
export const ROUTING_SCORERS = [
  'precise-prefix-cache',
  'queue-depth',
  'kv-utilization',
  'prefix-affinity',
  'no-hit-lru',
  'load-balance',
  'active-requests',
  'running-requests',
  'load-aware',
  'vllm-dp',
  'lora-affinity',
]
export const DEFAULT_ROUTING_SCORERS: { name: string; weight: number }[] = [
  { name: 'precise-prefix-cache', weight: 2 },
  { name: 'queue-depth', weight: 1 },
  { name: 'kv-utilization', weight: 1 },
]
export const ADMISSION_POLICIES = [
  'always-admit',
  'token-bucket',
  'tier-shed',
  'gaie-legacy',
  'reject-all',
]
export const KV_CACHE_DTYPES = ['auto', 'fp8', 'fp8_e4m3', 'fp8_e5m2', 'fp8_inc', 'bf16', 'fp16', 'fp32']
export const LATENCY_MODELS = ['trained-physics', 'roofline']

/**
 * MoE all-to-all comm backends (--moe-comm-backend). '' means unset (blis default,
 * allgather_reducescatter). blis charges the dispatch/combine cost only for a MoE model on
 * trained-physics with dp>1 or expert parallelism, and fatally rejects a non-empty backend
 * outside that. Mirrors latency.ValidMoECommBackends.
 */
export const MOE_COMM_BACKENDS = [
  '',
  'naive',
  'allgather_reducescatter',
  'pplx',
  'deepep_high_throughput',
  'deepep_low_latency',
  'mori',
  'flashinfer_all2allv',
]

/** PD disaggregation deciders (--pd-decider): when a request is split across the pools.
 * Mirrors sim.ValidDisaggregationDeciderNames (minus the "" alias for "never"). */
export const PD_DECIDERS = ['never', 'always', 'prefix-threshold']
/**
 * Speculative-decoding method labels. blis closes the set (sim/config.go's
 * isValidSpeculativeMethod: mtp|eagle|medusa|ngram|draft), with '' meaning unset — the
 * method is only meaningful when num_speculative_tokens > 0. Refresh alongside the other
 * enums above.
 */
export const SPECULATIVE_METHODS = ['', 'mtp', 'eagle', 'medusa', 'ngram', 'draft']

/**
 * The models the leaderboard offers: one per model directory in the blis-catalog
 * (https://github.com/inference-sim/blis-catalog/tree/main/models). A `--model` value is
 * stored and hashed into group_id verbatim, so each entry is a distinct comparability
 * group: picking a different model here starts a new table rather than adding a row.
 *
 * Every entry is org-prefixed (`<org>/<model>`). The leaderboard's own validation
 * requires it (schema/run.schema.json's `^[^/]+/[^/]+$` and internal/spec.Check both
 * reject a bare name) so that a model has one canonical spelling and cannot split into
 * two tables. This is a leaderboard rule, not a blis one: blis resolves the config by
 * the segment after the org (cmd/hfconfig.go's bundledModelConfigDir strips the prefix),
 * so it would accept the bare `qwen3-14b` too, but the leaderboard would not file the
 * result. An entry blis has not cached in model_configs/ yet is fetched from HuggingFace
 * on first run (README "Practical notes") and cached, so a catalog model need not already
 * be in the local model_configs/ directory to be offered here.
 *
 * To refresh: the segment after the slash is the model directory name verbatim
 * (`models/<name>/` in blis-catalog). The org prefix is that model's `model.yaml`
 * `source.repo` org, lowercased (e.g. `models/kimi-k3/model.yaml` has
 * `repo: moonshotai/Kimi-K3`, so `moonshotai/kimi-k3`); that org is also how defaults.yaml
 * and the HuggingFace fetch key the model. Keep `qwen/qwen3-14b` spelled exactly so: the
 * committed runs were declared under it, and any other spelling would hash to a different
 * group_id and orphan the existing table.
 *
 * Last checked against inference-sim/blis-catalog @ main on 2026-09-18.
 */
export const MODELS: string[] = [
  'codellama/codellama-34b-instruct-hf',
  'deepseek-ai/deepseek-v2-lite',
  'zai-org/glm-5.2',
  'zai-org/glm-5.2-fp8',
  'zai-org/glm-5.3',
  'thinkingmachines/inkling',
  'moonshotai/kimi-k3',
  'meta-llama/llama-2-70b-hf',
  'meta-llama/llama-2-7b-hf',
  'meta-llama/llama-3.1-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'redhatai/llama-4-scout-17b-16e-instruct-fp8-dynamic',
  'mistralai/mistral-nemo-instruct-2407',
  'mistralai/mixtral-8x22b-v0.1',
  'mistralai/mixtral-8x7b-v0.1',
  'nvidia/nemotron-3-ultra-550b-a55b-bf16',
  'nvidia/nemotron-3-ultra-550b-a55b-nvfp4',
  'nvidia/nemotron-3.5-lightning-30b-a3b-bf16',
  'nvidia/nemotron-3.5-lightning-30b-a3b-nvfp4',
  'qwen/qwen2.5-7b-instruct',
  'qwen/qwen3-14b',
  'qwen/qwen3-30b-a3b',
  '01-ai/yi-34b',
]

/**
 * The catalog models blis resolves as MoE (their config.json declares experts). The MoE
 * knobs (--enable-expert-parallel, --moe-comm-backend) apply only to these; blis fatally
 * rejects --enable-expert-parallel on a dense model, so the form guards them by this set
 * rather than spending a run to find out. Determined by grepping each model's config.json
 * for expert keys, so it is a fact about the same files blis reads, not a guess.
 *
 * Refresh by grepping each blis-catalog model's config.json for expert keys
 * (`"num_experts"`, `"n_routed_experts"`, or `"num_local_experts"`); a model in MODELS
 * whose config.json declares one belongs here.
 *
 * Last checked against inference-sim/blis-catalog @ main on 2026-09-18.
 */
export const MOE_MODELS: string[] = [
  'deepseek-ai/deepseek-v2-lite',
  'zai-org/glm-5.2',
  'zai-org/glm-5.2-fp8',
  'zai-org/glm-5.3',
  'thinkingmachines/inkling',
  'moonshotai/kimi-k3',
  'redhatai/llama-4-scout-17b-16e-instruct-fp8-dynamic',
  'mistralai/mixtral-8x22b-v0.1',
  'mistralai/mixtral-8x7b-v0.1',
  'nvidia/nemotron-3-ultra-550b-a55b-bf16',
  'nvidia/nemotron-3-ultra-550b-a55b-nvfp4',
  'nvidia/nemotron-3.5-lightning-30b-a3b-bf16',
  'nvidia/nemotron-3.5-lightning-30b-a3b-nvfp4',
  'qwen/qwen3-30b-a3b',
]

/** Whether blis will treat `model` as a MoE model, so the MoE knobs apply. */
export function isMoEModel(model: string): boolean {
  return MOE_MODELS.includes(model)
}
