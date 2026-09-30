import type { BLISLeaderboardRunRecord } from './types'
import { getPath, summarizeSpec, type SpecObject } from './spec'
import { PRESET_NAMES } from './catalog'

/** One row of one table. Alias so nothing depends on json2ts's derived name. */
export type RunRecord = BLISLeaderboardRunRecord

/**
 * A run's stable identity across the whole board: group_id and run_id together. A run_id is
 * unique only within one comparability group, and a sweep table now spans several (one per load
 * level), where the same deployment at different loads shares a run_id — so anything that keys a
 * run across the table (the Compare selection and row highlight) must key on this, not run_id.
 */
export function runKey(r: Pick<RunRecord, 'group_id' | 'run_id'>): string {
  return `${r.group_id}/${r.run_id}`
}

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

/** The offered-load axis of a workload profile: the kind ("rate" | "concurrency") and the
 *  distinct load values present, ascending. It is the dimension the Load filter selects and
 *  the Load column reads; a single-value axis is not a sweep (the filter/column stay hidden). */
export interface LoadAxis {
  kind: string
  values: number[]
}

/**
 * One workload profile: the work offered with the offered-load value factored out. Model left
 * the comparability key at E1; offered load leaves the workload key here, so a distribution
 * profile spans the comparability groups (`group_id`s) that differ only in rate/concurrency —
 * one `RunGroup` per load level. Model, hardware, and load are all filtered within one profile.
 * The grouping is client-side and in-memory only: the key never has to match a Go hash.
 */
export interface WorkloadGroup {
  /**
   * Canonical JSON of the group block with the offered-load value dropped (for a distribution;
   * spec and trace keep their full group). Runs differing only in load share this key.
   */
  workloadKey: string
  /** The comparability groups under this profile — one per offered-load level for a
   *  distribution sweep, otherwise one. */
  groups: RunGroup[]
  /** The offered-load levels present, sorted; more than one means a sweep. */
  loadAxis: LoadAxis
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

/** Order rows so each configuration's load levels are adjacent, in the order the configs first
 *  appear. Keys on the canonical deployment, so the same config at different loads groups. */
function byConfig(rows: RunRecord[]): RunRecord[] {
  const order: string[] = []
  const groups = new Map<string, RunRecord[]>()
  for (const r of rows) {
    const key = canonicalJSON(r.deployment)
    const g = groups.get(key)
    if (g) g.push(r)
    else {
      groups.set(key, [r])
      order.push(key)
    }
  }
  return order.flatMap((k) => groups.get(k)!)
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
    const complete = bucket.flatMap((g) => g.complete)
    const disqualified = bucket.flatMap((g) => g.disqualified)
    const name = workloadName(records)
    const summary = workloadTitle(bucket[0]!.group)
    const loadValues = [...new Set(bucket.map((g) => offeredLoad(g.group).value))].sort((a, b) => a - b)
    // A sweep spans several comparability groups, which flatMap concatenates low→high — so the
    // rows arrive pre-ordered by load. Regroup them by configuration instead, each config's load
    // levels adjacent: the natural way to read a scaling curve, and not pre-sorted by load, so
    // the Load column reorders on the first click and nothing is ordered by load until then (D3).
    const isSweep = loadValues.length > 1
    workloads.push({
      workloadKey: key,
      groups: bucket,
      loadAxis: { kind: offeredLoad(bucket[0]!.group).kind, values: loadValues },
      models: [...new Set(records.map((r) => r.deployment.model))].sort(),
      complete: isSweep ? byConfig(complete) : complete,
      disqualified: isSweep ? byConfig(disqualified) : disqualified,
      records: isSweep ? byConfig(records) : records,
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
 * The offered load of a workload, as one reading across every type. A distribution carries it
 * in `group.workload.load`; a workload-spec carries it inside the spec (a client's
 * `concurrency`, else the top-level `aggregate_rate`), with the flat value a placeholder; a
 * trace uses the group value. This is the single source the profile key strips, the load axis
 * lists, and the Load column and filter read, so the whole app agrees on what a run's load is.
 */
export function offeredLoad(group: RunRecord['group']): { kind: string; value: number } {
  const w = group.workload
  if (w.type === 'workload-spec') {
    const spec = (w.spec ?? null) as SpecObject | null
    const conc = spec ? getPath(spec, ['clients', 0, 'concurrency']) : undefined
    if (typeof conc === 'number') return { kind: 'concurrency', value: conc }
    const rate = spec ? getPath(spec, ['aggregate_rate']) : undefined
    if (typeof rate === 'number') return { kind: 'rate', value: rate }
  }
  return { kind: w.load.kind, value: w.load.value }
}

/**
 * The workload key: the group block canonicalised (keys sorted, recursively) as a map key, so
 * it never has to equal a Go hash. The offered-load value is a dimension varied within a
 * profile, not part of its identity, so it is stripped from the key — runs differing only in
 * load collapse into one workload. Where the load lives differs by type: a distribution drops
 * `load.value`; a workload-spec drops the spec's `aggregate_rate` and per-client `concurrency`
 * (and the derived `spec_sha256` that folds them in). A trace drops the placeholder `load.value`
 * and the replay's `concurrent_sessions` (the offered-load pool), so replaying one corpus at
 * several session counts collapses into a single sweep — the trace analog of a spec's concurrency.
 */
export function workloadKey(group: RunRecord['group']): string {
  const g = JSON.parse(JSON.stringify(group)) as {
    workload: {
      type: string
      load: { value?: number }
      spec_sha256?: unknown
      spec?: { aggregate_rate?: unknown; clients?: unknown[] }
      trace?: { concurrent_sessions?: unknown }
    }
  }
  const w = g.workload
  if (w.type === 'distribution') {
    delete w.load.value
  } else if (w.type === 'workload-spec') {
    delete w.load.value
    delete w.spec_sha256
    if (w.spec) {
      delete w.spec.aggregate_rate
      if (Array.isArray(w.spec.clients)) {
        for (const c of w.spec.clients) {
          if (c && typeof c === 'object') delete (c as { concurrency?: unknown }).concurrency
        }
      }
    }
  } else if (w.type === 'trace') {
    delete w.load.value
    if (w.trace) delete w.trace.concurrent_sessions
  }
  return canonicalJSON(g)
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
 * The profile title in one readable line, model omitted (a profile spans many models). For a
 * distribution the offered load is a dimension varied within the profile, so the title names
 * the request count and shape without a rate — the Load filter and Load column carry the level.
 * Spec and trace profiles keep their offered load in the title, since it does not vary for them.
 * The observation-window clause stays either way — a bounded window is part of the work offered.
 */
export function workloadTitle(group: RunRecord['group']): string {
  const window = group.horizon_ticks == null ? '' : ', bounded window'
  if (group.workload.type === 'distribution') {
    return `${group.workload.num_requests.toLocaleString('en-US')} requests${window}`
  }
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
  if (w.type === 'trace') {
    // A trace offers its recorded stream; a pool offers N concurrent sessions (the
    // offered-load analog of concurrency). The corpus size lives on the record's
    // trace_meta, not the group, so the group-level title names the shape, not the count.
    const sessions = w.trace?.concurrent_sessions ?? 0
    return sessions > 0
      ? `trace replay, ${sessions} concurrent sessions`
      : 'trace replay at recorded arrivals'
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
 * Merges the committed baseline (inlined at build time) with the live records the server
 * returns from its outDir, so the leaderboard shows both. A live record supersedes a
 * committed one with the same group_id/run_id (a re-run wins); committed records the live
 * set does not have are kept. This matters because `leaderboard serve`'s outDir may not be
 * the tree the bundle was built from — the default (~/leaderboard-results) holds only this
 * session's runs — so replacing committed with live would make the baseline vanish.
 */
export function mergeRecords(committed: RunRecord[], live: RunRecord[]): RunRecord[] {
  const key = (r: RunRecord) => `${r.group_id}/${r.run_id}`
  const inLive = new Set(live.map(key))
  return [...live, ...committed.filter((r) => !inLive.has(key(r)))]
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
