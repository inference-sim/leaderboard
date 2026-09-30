import type { RunRecord, WorkloadGroup } from './load'
import { keptByFilters } from './filter'
import { splitBySlo } from './slo'
import type { SloTargets } from './slo'
import { sortRecords } from './model'
import type { SortSpec } from './model'

/**
 * A workload's rows partitioned as the table renders them, from one filter/SLO/sort input, so
 * the table (three sections) and the Compare panel (columns in the same order) read from one
 * source and can never disagree about the order or the membership.
 */
export interface VisibleRows {
  /** Kept complete runs (model/hardware/load filters applied), before the SLO split. */
  complete: RunRecord[]
  /** Every kept record, complete and disqualified — for varying-field and Load-column checks. */
  records: RunRecord[]
  /** The ranked table rows: kept, SLO-passing, in the current sort. */
  ranked: RunRecord[]
  /** Kept complete runs a set SLO target pulled out — the SLO band. */
  slobanded: RunRecord[]
  /** Kept disqualified runs — the disqualified band. */
  disqualified: RunRecord[]
}

/** Partition a workload's rows for display. `sort` empty means declared/board order (nothing is
 *  ordered by load until the reader clicks, D3). */
export function visibleRows(
  workload: WorkloadGroup,
  models: string[],
  hardware: string[],
  loads: number[],
  sloTargets: SloTargets,
  sort: SortSpec[],
): VisibleRows {
  const keep = (r: RunRecord) => keptByFilters(r, models, workload.models, hardware, loads)
  const complete = workload.complete.filter(keep)
  const disqualified = workload.disqualified.filter(keep)
  const records = workload.records.filter(keep)
  const { passing, hidden } = splitBySlo(complete, sloTargets)
  return { complete, records, ranked: sortRecords(passing, sort), slobanded: hidden, disqualified }
}

/**
 * The visible rows flattened top to bottom — ranked rows, then the SLO band, then the
 * disqualified band — the order they read down the page and the order Compare opens its
 * columns in (top row = control).
 */
export function visibleOrder(v: VisibleRows): RunRecord[] {
  return [...v.ranked, ...v.slobanded, ...v.disqualified]
}
