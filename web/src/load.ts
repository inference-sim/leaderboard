import type { BLISLeaderboardRunRecord } from './types'
import { getPath, summarizeSpec, type SpecObject } from './spec'
import { PRESET_NAMES } from './catalog'

/** One row of one table. Alias so nothing depends on json2ts's derived name. */
export type RunRecord = BLISLeaderboardRunRecord

/**
 * One comparability group: one table. Every record in it was offered identical
 * work, which is structural rather than advisory — group_id is a content hash of
 * the group block, so a record whose ids do not match its own group is rejected.
 */
export interface RunGroup {
  groupId: string
  workId: string
  group: RunRecord['group']
  /** Complete runs, in declared order. Nothing is sorted on load (D3). */
  complete: RunRecord[]
  /** Disqualified runs. Shown in their own band, never filtered out. */
  disqualified: RunRecord[]
  /** Every record, complete and not. */
  records: RunRecord[]
  blisCommit: string
  /** True when any record was produced from a dirty upstream tree. */
  treeDirty: boolean
  /**
   * The catalog name the runs were declared with (a preset or saved profile), or null
   * when none carried one (a custom or runs.yaml run). It is a display label, not part
   * of the comparability key.
   */
  name: string | null
  /** The work in one line, e.g. "500 requests at 6.0 req/s" — the shape for a
   * distribution, the aggregate-rate summary for a spec. Used as the title when the runs
   * carry no catalog name. */
  summary: string
  /** Classification tags for the card: "preset" when the name is a built-in, then the
   * variant ("distribution" | "workload-spec"). */
  tags: string[]
  /**
   * What the card and section header show as the title: the name when the runs carry
   * one, else the summary. A group_id is a content hash — correct, stable, unreadable —
   * so with more than one table on the page the reader needs the sense of each before
   * reading a number.
   */
  title: string
}

/**
 * Buckets records into groups. One group is one table (D2), and records are loaded
 * eagerly at build time, so this runs once over everything in results/.
 */
export function loadGroups(records: RunRecord[]): RunGroup[] {
  const byId = new Map<string, RunRecord[]>()
  for (const r of records) {
    if (r.schema_version !== 1) {
      throw new Error(`${r.run_id}: schema_version ${r.schema_version}, this build reads 1`)
    }
    const bucket = byId.get(r.group_id)
    if (bucket) {
      // Two records sharing a group_id must agree about the work offered. If they
      // do not, one of them was hashed from a different group block and putting
      // them in one table would compare nothing.
      const first = bucket[0]!
      if (JSON.stringify(first.group) !== JSON.stringify(r.group)) {
        throw new Error(
          `${r.run_id} and ${first.run_id} share group_id ${r.group_id} but declare ` +
            `different work offered; one of them was not hashed from its own group block`,
        )
      }
      bucket.push(r)
    } else {
      byId.set(r.group_id, [r])
    }
  }

  const groups: RunGroup[] = []
  for (const [groupId, bucket] of byId) {
    const first = bucket[0]!
    const name = workloadName(bucket)
    const summary = groupTitle(first.group)
    groups.push({
      groupId,
      workId: first.work_id,
      group: first.group,
      records: bucket,
      complete: bucket.filter((r) => r.status.complete),
      disqualified: bucket.filter((r) => !r.status.complete),
      blisCommit: first.provenance.blis_commit,
      treeDirty: bucket.some((r) => r.provenance.blis_tree_dirty),
      name,
      summary,
      tags: workloadTags(name, first.group.workload.type),
      title: name ?? summary,
    })
  }
  groups.sort(compareGroups)
  return groups
}

/**
 * One workload: the work offered. With `model` moved out of the comparability key (E1),
 * the workload key and `group_id` are now a bijection, so a workload maps to exactly one
 * comparability group; the layer is kept because the picker and Workloads tab speak in
 * workloads, and model and hardware are filtered within one. The grouping is client-side
 * and in-memory only: the key never has to match a Go hash.
 */
export interface WorkloadGroup {
  /**
   * Canonical JSON of the group block, keys sorted. Equal to what `group_id` hashes now
   * that the group carries no model, so one workload is one comparability group.
   */
  workloadKey: string
  /** The comparability group(s) under this workload — exactly one since E1. */
  groups: RunGroup[]
  /** The models present across the rows, sorted. Empty selection in the filter means all. */
  models: string[]
  /** Every model's complete runs, merged, ordered by model then declared order. */
  complete: RunRecord[]
  /** Every model's disqualified runs, merged, never hidden. */
  disqualified: RunRecord[]
  /** Every record under this workload, complete and not. */
  records: RunRecord[]
  /** True when any record under this workload came from a dirty upstream tree. */
  treeDirty: boolean
  /** The blis commits present, sorted and de-duplicated — usually one. */
  blisCommits: string[]
  /** The catalog name the runs were declared with (a preset or saved profile), or null
   * when none carried one. A display label, not part of the comparability key. */
  name: string | null
  /** The work in one line — the distribution shape or a spec's aggregate-rate summary.
   * Used as the title when the runs carry no catalog name. */
  summary: string
  /** Classification tags for the card: "preset" when the name is a built-in, then the
   * variant ("distribution" | "workload-spec"). */
  tags: string[]
  /**
   * What the picker card and section header show: the name when the runs carry one, else
   * the summary. Model is omitted either way — a workload spans many models, so the model
   * belongs in the filter and the Model column, not the workload's own title.
   */
  title: string
}

/**
 * Groups records into workloads (W1): buckets the comparability groups from
 * `loadGroups` — whose per-group_id integrity check still runs and still matters — by
 * the work they offered with model removed. One workload is one page section.
 */
export function loadWorkloads(records: RunRecord[]): WorkloadGroup[] {
  const groups = loadGroups(records)
  const byWorkload = new Map<string, RunGroup[]>()
  for (const g of groups) {
    const key = workloadKey(g.group)
    const bucket = byWorkload.get(key)
    if (bucket) bucket.push(g)
    else byWorkload.set(key, [g])
  }

  const workloads: WorkloadGroup[] = []
  for (const [key, bucket] of byWorkload) {
    bucket.sort(compareGroups)
    const records = bucket.flatMap((g) => g.records)
    const name = workloadName(records)
    const summary = workloadTitle(bucket[0]!.group)
    workloads.push({
      workloadKey: key,
      groups: bucket,
      models: [...new Set(records.map((r) => r.deployment.model))].sort(),
      complete: bucket.flatMap((g) => g.complete),
      disqualified: bucket.flatMap((g) => g.disqualified),
      records,
      treeDirty: bucket.some((g) => g.treeDirty),
      blisCommits: [...new Set(bucket.map((g) => g.blisCommit))].sort(),
      name,
      summary,
      tags: workloadTags(name, bucket[0]!.group.workload.type),
      title: name ?? summary,
    })
  }
  workloads.sort((a, b) => compareWorkloads(a.groups[0]!, b.groups[0]!))
  return workloads
}

/**
 * The workload key: the group block with `model` removed, canonicalised the same way
 * `internal/schema/canon.go` canonicalises for the Go hash (keys sorted, recursively)
 * — but only as a map key here, so it never has to equal that hash.
 */
export function workloadKey(group: RunRecord['group']): string {
  // The group no longer carries a model (E1), so its canonical form is the workload
  // key: equal to what group_id hashes, one workload to one comparability group.
  return canonicalJSON(group)
}

/** Stable JSON with object keys sorted recursively. Arrays keep their order. */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`
}

/** compareGroups minus the model key: workloads are ordered by the work they offered. */
function compareWorkloads(a: RunGroup, b: RunGroup): number {
  const ag = a.group
  const bg = b.group
  return (
    cmp(ag.workload.num_requests, bg.workload.num_requests) ||
    cmp(ag.workload.load.kind, bg.workload.load.kind) ||
    cmp(ag.workload.load.value, bg.workload.load.value) ||
    cmp(ag.horizon_ticks ?? 0, bg.horizon_ticks ?? 0) ||
    cmp(ag.seed, bg.seed) ||
    cmp(a.workId, b.workId)
  )
}

/**
 * Orders the page. Sorting on group_id put the tables in hash order, which is
 * stable but arbitrary. This orders them the way a reader scans them: by how much work
 * was offered, then by how hard it was offered, and only then by the fields that
 * separate near-identical groups (window, then seed). Model is no longer a group field
 * (E1), so it no longer orders tables — it is a per-row candidate. group_id breaks the
 * final tie, so the order is still deterministic across builds.
 *
 * A workload-spec group carries placeholder zeros in num_requests/load (its real load is
 * in the spec), so spec groups tie on the first keys and fall through to the stable
 * group_id — arbitrary but deterministic. Ordering spec tables by their spec content is a
 * later refinement, not needed for correctness.
 */
export function compareGroups(a: RunGroup, b: RunGroup): number {
  const ag = a.group
  const bg = b.group
  return (
    cmp(ag.workload.num_requests, bg.workload.num_requests) ||
    cmp(ag.workload.load.kind, bg.workload.load.kind) ||
    cmp(ag.workload.load.value, bg.workload.load.value) ||
    // Unbounded first: it is the group that offered the work no observation window
    // could cut short.
    cmp(ag.horizon_ticks ?? 0, bg.horizon_ticks ?? 0) ||
    cmp(ag.seed, bg.seed) ||
    cmp(a.groupId, b.groupId)
  )
}

function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The work in one readable line: one comparability group's title. Model is no longer
 * part of the group (E1), so it is not named here; it is a per-row candidate carried by
 * the Model column and the filter.
 */
export function groupTitle(group: RunRecord['group']): string {
  const window = group.horizon_ticks == null ? '' : ', bounded window'
  return `${workOffered(group)}${window}`
}

/**
 * The work in one readable line, model omitted: a workload spans many models, so its
 * title names the work and leaves the model to the filter and the Model column. The
 * observation-window clause stays — a bounded window is part of the work offered.
 */
export function workloadTitle(group: RunRecord['group']): string {
  const window = group.horizon_ticks == null ? '' : ', bounded window'
  return `${workOffered(group)}${window}`
}

/**
 * "500 requests at 6.0 req/s" — the brief shape, shared by both titles so they cannot
 * drift. For a workload-spec the flat num_requests/load are placeholder zeros (the real
 * load lives in the spec), so the count and rate are read from the spec's own top-level
 * fields, in the same wording, rather than printing "0 requests at 0.0 req/s".
 */
function workOffered(group: RunRecord['group']): string {
  const w = group.workload
  if (w.type === 'workload-spec') {
    return specShape((w.spec ?? null) as SpecObject | null)
  }
  const load =
    w.load.kind === 'rate'
      ? `${w.load.value.toLocaleString('en-US', { minimumFractionDigits: 1 })} req/s`
      : `${w.load.value} concurrent sessions`
  return `${w.num_requests.toLocaleString('en-US')} requests at ${load}`
}

/**
 * A spec's brief shape from its top-level offered load — the request count and aggregate
 * rate — in the distribution wording so a spec and a distribution table read alike. The
 * variant is carried by a tag beside the title, not by the words here. A spec that states
 * neither (a cohort- or trace-driven load) falls back to summarizeSpec.
 */
function specShape(spec: SpecObject | null): string {
  const requests = spec ? getPath(spec, ['num_requests']) : undefined
  const rate = spec ? getPath(spec, ['aggregate_rate']) : undefined
  const haveReq = typeof requests === 'number'
  const haveRate = typeof rate === 'number'
  const rateStr = haveRate ? (rate as number).toLocaleString('en-US', { minimumFractionDigits: 1 }) : ''
  if (haveReq && haveRate) return `${(requests as number).toLocaleString('en-US')} requests at ${rateStr} req/s`
  if (haveRate) return `${rateStr} req/s aggregate`
  if (haveReq) return `${(requests as number).toLocaleString('en-US')} requests`
  return summarizeSpec(spec)
}

/**
 * The catalog name shared by a set of records: the first non-empty workload_name. All
 * records in one group offered identical work, but a run declared from the custom card
 * (or runs.yaml) carries no name, so a group can mix named and unnamed rows; the name is
 * shown when any row has one. null when none do.
 */
function workloadName(records: RunRecord[]): string | null {
  for (const r of records) {
    if (r.workload_name) return r.workload_name
  }
  return null
}

/**
 * The classification tags for a workload's card: "preset" when it was declared with a
 * built-in (its name is reserved, so this is reliable without the catalog), then the
 * variant — "distribution" or "workload-spec". Ordered most-general first.
 */
function workloadTags(name: string | null, type: string): string[] {
  const tags: string[] = []
  if (name && PRESET_NAMES.includes(name)) tags.push('preset')
  tags.push(type)
  return tags
}

/**
 * Every record under results/, inlined at build time. The glob reaches above the
 * Vite root, which vite.config.ts allows.
 */
export function loadCommittedRecords(): RunRecord[] {
  const modules = import.meta.glob<RunRecord>('../../results/*/*.json', {
    eager: true,
    import: 'default',
  })
  return Object.entries(modules)
    .filter(([path]) => !path.endsWith('.requests.json'))
    .map(([, record]) => record)
}
