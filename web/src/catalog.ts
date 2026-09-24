/**
 * Snapshots of upstream facts the form needs to offer choices. This screen is
 * pure front-end — it emits a declaration for the CLI to run rather than running
 * blis itself — so these option lists cannot be read from the simulator at request
 * time and are committed here instead.
 *
 * The model and hardware catalogues are the exceptions: they are served live from the
 * running server (GET /api/models, GET /api/hardware) rather than snapshotted here, so they
 * cannot go stale. See models.ts and hardware.ts. What remains below are the closed sets of
 * flag values blis accepts, refreshed against ../inference-sim/cmd/root.go as noted per list.
 */

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

