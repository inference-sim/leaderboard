/**
 * The live-run flow's data and pure helpers, kept out of the components so their claims
 * are testable in isolation.
 *
 * A run is declared on the Declare screen, then watched on the Leaderboard where its
 * result belongs. `App` owns one `LiveRun` and drives the single blocking `fetch`; these
 * helpers turn a declaration into the display facts the board needs before any group_id
 * exists, and name the DOM id the reveal scrolls to.
 */

import type { WorkloadGroup, RunRecord } from './load'
import { workloadKey, workloadTitle } from './load'
import type { Output } from './newrun'

/**
 * The display facts known at click time, before blis has run and before any group_id
 * exists, so the banner can describe the run while it is still running. `workloadKey`
 * and `workloadTitle` are pure functions of the declared `group` block, so no server
 * round-trip is needed to know which table the run belongs to or how to name it.
 */
export interface RunDecl {
  runId: string
  model: string
  /** workloadKey(output.group): which table the run will land in. */
  workloadKey: string
  /** workloadTitle(output.group): how to name that table in the banner. */
  workloadTitle: string
}

/**
 * The one live run `App` tracks. The in-flight `fetch` is the only "in progress" signal;
 * there is no server-side job to poll, so this state machine is the whole story.
 */
export type LiveRun =
  | null
  | { status: 'running'; decl: RunDecl }
  | { status: 'done'; decl: RunDecl; record: RunRecord }
  | { status: 'error'; decl: RunDecl; message: string }

/** A request to scroll to and highlight one row, set by the banner's "View the run". */
export interface RevealTarget {
  groupId: string
  runId: string
}

/**
 * The DOM id of one run's table row. A run is identified by group_id + run_id rather than
 * by position, so the scroll target is correct whether the run joined an existing table or
 * opened a new one, and whether the table is single-group or merged-model.
 */
export function rowId(record: Pick<RunRecord, 'group_id' | 'run_id'>): string {
  return `run-${record.group_id}-${record.run_id}`
}

/** Builds the display facts for the banner from a validated declaration. */
export function runDeclFromOutput(output: Output): RunDecl {
  return {
    runId: output.runId,
    model: output.deployment.model,
    workloadKey: workloadKey(output.group),
    workloadTitle: workloadTitle(output.group),
  }
}

/**
 * The workloadKey of the workload that holds the comparability group `groupId`, or null
 * when no loaded workload does (the record is not yet in `records`). Since E1 made
 * workload and group_id a bijection this is exactly the workload the reveal must select.
 */
export function workloadKeyForGroup(
  workloads: WorkloadGroup[],
  groupId: string,
): string | null {
  const w = workloads.find((w) => w.groups.some((g) => g.groupId === groupId))
  return w ? w.workloadKey : null
}
