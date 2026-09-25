/**
 * The canonical, ordered map of Declare-form flag-group title to the Deployment field keys
 * that belong under it. The single source for "grouped like Declare": the Compare panel lays
 * its configuration section out from this, and a unit test pins the titles and order against
 * NewRun.tsx and the field lists against the schema's Deployment keys, so a field added to
 * the schema cannot silently fall outside every group.
 *
 * NewRun may later drive its own grouping from this map; that refactor is out of scope here,
 * but the map is written so it can.
 */
export interface FieldGroup {
  title: string
  /** Deployment field keys, in a natural reading order for the group. */
  fields: string[]
}

export const FIELD_GROUPS: FieldGroup[] = [
  {
    title: 'Model & sharding',
    fields: ['model', 'hardware', 'tp', 'dp', 'enable_expert_parallel', 'moe_comm_backend', 'max_model_len'],
  },
  {
    title: 'Scheduling & batching',
    fields: ['scheduler', 'preemption_policy', 'max_num_seqs', 'max_num_batched_tokens', 'long_prefill_token_threshold'],
  },
  {
    title: 'KV cache',
    fields: ['kv_cache_dtype', 'block_size_in_tokens', 'gpu_memory_utilization'],
  },
  {
    title: 'Cluster',
    fields: ['num_instances'],
  },
  {
    title: 'Prefill/decode split',
    fields: ['disaggregation'],
  },
  {
    title: 'Admission & routing',
    fields: ['admission_policy', 'routing_policy', 'routing_scorers'],
  },
  {
    title: 'Speculative decoding',
    fields: ['num_speculative_tokens', 'speculative_acceptance_rate', 'speculative_method'],
  },
  {
    title: 'Simulation model',
    fields: ['latency_model'],
  },
]

/**
 * Deployment keys the panel renders outside the group map. extra_flags has no first-class
 * field and no Declare group: every entry is part of row identity (A3) and is rendered
 * unconditionally, so it is covered here rather than in a group.
 */
export const SEPARATELY_RENDERED = ['extra_flags'] as const
