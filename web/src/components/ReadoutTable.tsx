import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { RunRecord, WorkloadGroup } from '../load'
import { offeredLoad, runKey } from '../load'
import { rowId } from '../liverun'
import type { RevealTarget } from '../liverun'
import { formatCount, formatMs, formatNumber, formatPercent } from '../format'
import {
  COLUMNS,
  LOAD_COLUMN,
  NUMERIC_COLUMNS,
  deploymentSpec,
  distinctHardware,
  distinctModels,
  gpuCount,
  groupStartKeys,
  groupedHeaders,
  preemptionRate,
  servedFraction,
  varyingDeploymentFields,
} from '../model'
import type { Column, SortSpec } from '../model'
import type { SloTargets } from '../slo'
import { visibleRows } from '../rows'
import { Derived } from './Derived'
import { DeleteRunButton } from './DeleteRunButton'
import { Knob } from './Knob'
import { DqWhy } from './DqWhy'
import { ReproPanel } from './ReproPanel'
import { SloBand } from './SloBand'
import { SortNote } from './SortNote'

interface Props {
  workload: WorkloadGroup
  /**
   * The models to show — the literal set the reader selected. WorkloadSection seeds this
   * with every model and intercepts the empty case with a note, so it only ever passes a
   * non-empty list here; an empty array is still read as "all" as a defensive fallback for
   * direct callers and tests.
   */
  models: string[]
  /**
   * The hardware to show — likewise the literal selected set, empty read as all. Both
   * filters only narrow which rows show; neither changes what table you are in, and
   * nothing about the table is ranked automatically (E4, E5).
   */
  hardware?: string[]
  /**
   * The offered-load levels to show — the literal selected set of the profile's load axis,
   * empty read as all. Like model and hardware it only narrows rows. When more than one level
   * is on screen the table grows a Load column (before Deployment) so a load is never a hidden
   * difference; a single level omits it. Defaults to [] (all) for callers with no load axis.
   */
  loads?: number[]
  /**
   * A row to scroll to and highlight, set when a freshly run candidate lands and the reader
   * clicks "View the run" (§7). Acted on only when the target belongs to this table; the
   * section is remounted with filters reset first, so the row is never hidden behind a
   * filter. null (the resting case) does nothing.
   */
  revealTarget?: RevealTarget | null
  /** Called once the reveal has scrolled and highlighted, so App can clear the request. */
  onRevealed?: () => void
  /**
   * Whether the per-run delete control is offered. It is true only when the run server is
   * reachable — deleting removes the run's results file from disk, which the static build
   * cannot do — so the trash button never appears where it could not work. Defaults to
   * false, so a caller (or test) that omits it renders no delete affordance.
   */
  canDelete?: boolean
  /** Opens the delete confirmation for a run. App owns the confirm, the call, and the reload. */
  onDelete?: (record: RunRecord) => void
  /**
   * The parsed SLO targets: a maximum-milliseconds ceiling per latency metric. A run must
   * sit at or below every set target to stay in the ranked table; the rest are relocated to
   * the SloBand beneath it, never dropped. Defaults to no targets, so existing callers and
   * tests are unaffected. Applied only to the ranked table, never to the disqualified band.
   */
  sloTargets?: SloTargets
  /**
   * Whether the table is in compare mode: a row-click highlights the run for comparison
   * instead of opening its reproduce panel. Defaults to false (repro-on-click, as before).
   */
  compareMode?: boolean
  /** The run_ids currently highlighted for comparison. A highlighted row carries `cmphl`. */
  selectedIds?: string[]
  /** Toggle a run's highlight membership. Required for compare mode to do anything. */
  onToggleHighlight?: (runId: string) => void
  /**
   * The active sort, owned by the section so the Compare panel can open its columns in the very
   * order the table renders. Empty means declared/board order — nothing is ordered by load until
   * the reader clicks (D3). Defaults to [] for direct callers and tests.
   */
  sort?: SortSpec[]
  /** Cycle a column's sort on a header click (ascending → descending → off). */
  onSort?: (key: string) => void
  /** Drop one sort tier via its chip in the sort note. */
  onRemoveSort?: (key: string) => void
}

/**
 * One workload's table. With `model` moved out of the comparability key (E1) a workload
 * is one comparability group whose rows may vary in both model and hardware; the model
 * and hardware selections narrow the rows, and the model leads each deployment cell as a
 * prominent field when more than one is shown. Columns sort on click and nothing sorts
 * on load; no per-column best is marked, because across mixed models that would crown the
 * smaller model rather than the better deployment (E4, E5).
 */
export function ReadoutTable({
  workload,
  models,
  hardware = [],
  revealTarget,
  onRevealed,
  canDelete = false,
  onDelete,
  sloTargets = {},
  loads = [],
  compareMode = false,
  selectedIds = [],
  onToggleHighlight,
  sort = [],
  onSort,
  onRemoveSort,
}: Props) {
  const showDelete = canDelete && onDelete != null
  // The run_id of the row currently pulsing from a reveal, or null. Local to the table so
  // the highlight lives and dies with the row, not with App's reveal request.
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  // Every column is shown, including the KV cache group, which appends to the right of the
  // health group. The table scrolls horizontally in its own frame (see .tscroll in
  // styles.css), so the extra columns are reached by scrolling, never crowded out.
  const visibleCols = COLUMNS
  const numericCols = NUMERIC_COLUMNS
  // The group-separator boundaries. A shared helper the header and every body cell read, so
  // separators cannot drift between them.
  const starts = useMemo(() => groupStartKeys(visibleCols), [visibleCols])
  const sep = (key: string): string | undefined => (starts.has(key) ? 'gsep' : undefined)

  // The rows as displayed, from the single shared source, so the Compare panel opens its columns
  // in the very order the table renders — the same filter, SLO split, and sort.
  const { complete, records, ranked: rows, slobanded: hidden, dqRanked } = useMemo(
    () => visibleRows(workload, models, hardware, loads, sloTargets, sort),
    [workload, models, hardware, loads, sloTargets, sort],
  )
  // Mean output tokens per served request across the complete runs on screen, for the size-bias
  // comparison in a disqualified row's why-block. null when there is no complete run to compare
  // against (e.g. an all-disqualified sweep), which reads as "no baseline" rather than "0".
  const completePerReqMean = useMemo(() => {
    const perReq = complete
      .map((r) => (r.metrics.completed_requests > 0 ? r.metrics.total_output_tokens / r.metrics.completed_requests : null))
      .filter((v): v is number => v != null)
    return perReq.length === 0 ? null : perReq.reduce((a, b) => a + b, 0) / perReq.length
  }, [complete])

  const varying = useMemo(() => varyingDeploymentFields(records), [records])
  // Only label the model or GPU type when the table holds more than one: a single-model
  // or single-accelerator table already names it in its filter card.
  const showModel = useMemo(() => distinctModels(complete).length > 1, [complete])
  const showHardware = useMemo(() => distinctHardware(complete).length > 1, [complete])
  // Show the Load column only when more than one offered-load level is on screen; a single
  // level names itself in the Load filter, so a constant column would be noise.
  const showLoad = useMemo(
    () => new Set(records.map((r) => offeredLoad(r.group).value)).size > 1,
    [records],
  )
  // The Load column is named for what it varies: "Arrival rate" for a rate sweep, "Concurrency"
  // for a concurrency one, "Concurrent sessions" for a trace's session-pool sweep. Same key
  // ('load') so it sorts through sortRecords like any column.
  const loadCol = useMemo(
    () => ({
      ...LOAD_COLUMN,
      label:
        workload.loadAxis.kind === 'concurrency'
          ? 'Concurrency'
          : workload.loadAxis.kind === 'sessions'
            ? 'Concurrent sessions'
            : 'Arrival rate',
    }),
    [workload.loadAxis.kind],
  )
  const repro = useReproToggles(rows)
  // The table is replaced by a short note only when a target removed every complete row and
  // there are no disqualified rows to show either; a group with only disqualified runs (a
  // windowed sweep) still renders them inline, so it is never mistaken for empty.
  const allHiddenBySlo = rows.length === 0 && hidden.length > 0 && dqRanked.length === 0

  // The reveal: once a target row belonging to this table is on screen, scroll it into
  // view and mark it so the CSS pulse (or, under reduce, a static outline) plays, then clear
  // both after about two seconds and tell App the request is spent. jsdom has no layout, so
  // scrollIntoView is a no-op there; the highlight and the clear still run and are tested.
  useEffect(() => {
    if (!revealTarget) return
    const target = records.find(
      (r) => r.group_id === revealTarget.groupId && r.run_id === revealTarget.runId,
    )
    if (!target) return
    const el = typeof document !== 'undefined' ? document.getElementById(rowId(target)) : null
    el?.scrollIntoView({ block: 'center' })
    setRevealedKey(runKey(target))
    const timer = setTimeout(() => {
      setRevealedKey(null)
      onRevealed?.()
    }, 2000)
    return () => clearTimeout(timer)
  }, [revealTarget, records, onRevealed])

  // Sorting is owned by the section (so Compare can mirror it); a direct caller/test that passes
  // no handler simply cannot sort, which is fine for the static render tests.
  const toggle = onSort ?? (() => {})
  const headerGroups = groupedHeaders(visibleCols, showLoad)

  return (
    <>
      {allHiddenBySlo ? (
        <p className="slonote">
          No runs meet the SLO targets. Every complete run missed at least one target you set;
          each is listed below with the target it missed.
        </p>
      ) : (
        <>
          <TableTools
            sort={sort}
            onRemoveSort={onRemoveSort ?? (() => {})}
            repro={repro}
            showControls={true}
          />

          {/* The table scrolls in its own frame (.tscroll): a wide readout stays within the
              page margin and gets a horizontal scrollbar right under it, rather than cropping
              off-screen and relying on the whole page to scroll sideways. The header freezes at
              the top of the frame and the leading columns at its left. With a Load column present
              the table freezes both the Load and Deployment columns (hasload): they stack at the
              left edge, so the reader keeps the load level and the candidate in view while the
              metrics scroll. A gray separator sits between them (see .hasload .lft in
              styles.css). */}
          <div className="tscroll">
            <table className={showLoad ? 'readout hasload' : 'readout'}>
              <thead>
                <tr className="grp">
                  {headerGroups.map((h, i) => (
                    <th
                      key={`${h.group}-${i}`}
                      colSpan={h.span}
                      scope="colgroup"
                      // gcol-<group> lets the leading group cells (the blank Load cell and the
                      // candidate cell, which spans Deployment+GPUs) freeze horizontally over the
                      // frozen columns; the blank Load cell's group is '' so it is tagged 'lead'.
                      className={[i > 0 ? 'gsep' : '', `gcol-${h.group || 'lead'}`].filter(Boolean).join(' ')}
                    >
                      {h.group}
                    </th>
                  ))}
                </tr>
                <tr>
                  {showLoad && <HeaderCell col={loadCol} sort={sort} onSort={toggle} sep={sep} />}
                  {visibleCols.map((col) => (
                    <HeaderCell key={col.key} col={col} sort={sort} onSort={toggle} sep={sep} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <DataRow
                    key={runKey(record)}
                    record={record}
                    varying={varying}
                    numericCols={numericCols}
                    sep={sep}
                    colCount={visibleCols.length}
                    showModel={showModel}
                    showHardware={showHardware}
                    showLoad={showLoad}
                    open={repro.isOpen(record)}
                    onToggleRepro={() => repro.toggle(record)}
                    revealed={revealedKey === runKey(record)}
                    onDelete={showDelete ? onDelete : undefined}
                    compareMode={compareMode}
                    highlighted={selectedIds.includes(runKey(record))}
                    onToggleHighlight={onToggleHighlight}
                  />
                ))}
                {/* Disqualified runs, shown rather than hidden (CLAUDE.md), grouped beneath the
                    ranked rows under a divider so a windowed/incomplete run is never ranked beside
                    a complete one. They sort among themselves via the same sort; each row is muted
                    and flagged, and expanding it shows why (DqWhy) above its blis command. */}
                {dqRanked.length > 0 && (
                  <>
                    <tr className="dqsub">
                      <td colSpan={visibleCols.length + (showLoad ? 1 : 0)}>
                        <span className="dqflag" aria-hidden="true">
                          ⚠
                        </span>{' '}
                        Windowed · incomplete — {dqRanked.length}{' '}
                        {dqRanked.length === 1 ? 'run' : 'runs'}, shown but not ranked (percentiles
                        describe a subset of the declared work)
                      </td>
                    </tr>
                    {dqRanked.map((record) => (
                      <DataRow
                        key={runKey(record)}
                        record={record}
                        varying={varying}
                        numericCols={numericCols}
                        sep={sep}
                        colCount={visibleCols.length}
                        showModel={showModel}
                        showHardware={showHardware}
                        showLoad={showLoad}
                        open={repro.isOpen(record)}
                        onToggleRepro={() => repro.toggle(record)}
                        revealed={revealedKey === runKey(record)}
                        onDelete={showDelete ? onDelete : undefined}
                        compareMode={compareMode}
                        highlighted={selectedIds.includes(runKey(record))}
                        onToggleHighlight={onToggleHighlight}
                        dq
                        completePerReqMean={completePerReqMean}
                      />
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SloBand
        hidden={hidden}
        targets={sloTargets}
        compareMode={compareMode}
        selectedIds={selectedIds}
        onToggleHighlight={onToggleHighlight}
      />
    </>
  )
}

/** A row's key in the open-reproduce set. run_id is unique within a group; group_id
 * disambiguates when tables are ever assembled from more than one. */
function reproKey(record: RunRecord): string {
  return `${record.group_id}:${record.run_id}`
}

/**
 * Owns which rows have their reproduce (blis command) panel open. Each row still toggles
 * on its own click; this only adds a shared handle so one control can open or close every
 * row at once. Keys not in the current `rows` (a filter narrowed them away) simply never
 * render — the set is not pruned, so a row that returns comes back in the state it left.
 */
function useReproToggles(rows: RunRecord[]) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const keys = useMemo(() => rows.map(reproKey), [rows])
  const isOpen = (record: RunRecord) => open.has(reproKey(record))
  const toggle = (record: RunRecord) =>
    setOpen((prev) => {
      const next = new Set(prev)
      const key = reproKey(record)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return {
    isOpen,
    toggle,
    expandAll: () => setOpen(new Set(keys)),
    collapseAll: () => setOpen(new Set()),
    // Over the visible rows only, so the bulk buttons reflect what is on screen. With no
    // rows both read true, so the always-shown control rests with both buttons disabled.
    allOpen: keys.every((k) => open.has(k)),
    noneOpen: keys.every((k) => !open.has(k)),
  }
}

/**
 * Expand-all / collapse-all for the table's reproduce panels. Each button disables itself
 * once it would be a no-op (everything already open, or already closed), which doubles as
 * a resting-state read of whether any command is showing. The disqualified band keeps its
 * own per-run toggles; this control is the table's rows only.
 */
function ReproControls({
  allOpen,
  noneOpen,
  onExpandAll,
  onCollapseAll,
}: {
  allOpen: boolean
  noneOpen: boolean
  onExpandAll: () => void
  onCollapseAll: () => void
}) {
  return (
    <div className="rowtools" role="group" aria-label="Reproduce commands for every row">
      <button
        type="button"
        className="rowtool"
        onClick={onExpandAll}
        disabled={allOpen}
        aria-label="Expand every row to show its blis command"
      >
        <span className="car" aria-hidden="true">
          ▾
        </span>
        Expand all
      </button>
      <button
        type="button"
        className="rowtool"
        onClick={onCollapseAll}
        disabled={noneOpen}
        aria-label="Collapse every row to hide its blis command"
      >
        <span className="car" aria-hidden="true">
          ▸
        </span>
        Collapse all
      </button>
    </div>
  )
}

/**
 * The bar above the table: the removable sort chips on the left, then the expand/collapse-all
 * control on the right. The right-side control is always shown; each expand/collapse button
 * disables itself when it would be a no-op, so the pair also reads as the resting state.
 */
function TableTools({
  sort,
  onRemoveSort,
  repro,
  showControls,
}: {
  sort: SortSpec[]
  onRemoveSort: (key: string) => void
  repro: ReturnType<typeof useReproToggles>
  showControls: boolean
}) {
  if (sort.length === 0 && !showControls) return null
  return (
    <div className="tabletools">
      <SortNote sort={sort} onRemove={onRemoveSort} />
      {showControls && (
        <div className="rowtools">
          <ReproControls
            allOpen={repro.allOpen}
            noneOpen={repro.noneOpen}
            onExpandAll={repro.expandAll}
            onCollapseAll={repro.collapseAll}
          />
        </div>
      )}
    </div>
  )
}

function HeaderCell({
  col,
  sort,
  onSort,
  sep,
}: {
  col: Column
  sort: SortSpec[]
  onSort: (key: string) => void
  /** The group-separator class for a column key, tracking the visible column set. */
  sep: (key: string) => string | undefined
}) {
  const sortable = col.key !== 'deployment'
  const idx = sort.findIndex((s) => s.key === col.key)
  const active = idx !== -1
  const dir = active ? sort[idx]!.dir : 1
  // The rank only reads as a rank when more than one column is in play; a lone sort
  // needs no "1" beside its caret.
  const rank = active && sort.length > 1 ? idx + 1 : null
  // The frozen "candidate identity" block stacks at the left edge on horizontal scroll: the
  // Load column (lcol, left:0), the Deployment column (lft), and the GPUs column (gpcol), so the
  // reader keeps the candidate in view while the metrics scroll. Every other column takes its
  // group-separator class.
  const className =
    col.key === 'deployment'
      ? 'lft'
      : col.key === 'load'
        ? 'lcol'
        : col.key === 'gpus'
          ? 'gpcol'
          : sep(col.key)
  const label = active
    ? `${col.label}, sorted ${dir === 1 ? 'ascending' : 'descending'}${
        rank != null ? `, sort priority ${rank}` : ''
      }`
    : `Sort by ${col.label}`
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      {sortable ? (
        <button type="button" className="sortbtn" onClick={() => onSort(col.key)} aria-label={label}>
          <span aria-hidden="true">{col.label}</span>
          <span className="car" aria-hidden="true">
            {active ? (dir === 1 ? '▲' : '▼') : '⇅'}
          </span>
          {rank != null && (
            <span className="rank" aria-hidden="true">
              {rank}
            </span>
          )}
        </button>
      ) : (
        col.label
      )}
      {col.help && (
        <span className="info" tabIndex={0} role="note" data-tip={col.help} aria-label={col.help}>
          i
        </span>
      )}
    </th>
  )
}

/**
 * One run: its numeric row, and — when the reader opens it — a panel beneath spanning
 * the whole table with the exact blis command that produced it. The row is the toggle:
 * clicking anywhere on it opens the panel, so there is nothing to hunt for. Two clicks
 * are let through untouched — one on any of the row's own controls (the "show all"
 * button, an info tooltip, or the panel's copy button), and one that was really the end
 * of a text selection the reader dragged across a cell — so opening the command never
 * fights reading the numbers.
 */
function DataRow({
  record,
  varying,
  numericCols,
  sep,
  colCount,
  showModel,
  showHardware,
  showLoad,
  open,
  onToggleRepro,
  revealed,
  onDelete,
  compareMode,
  highlighted,
  onToggleHighlight,
  dq = false,
  completePerReqMean = null,
}: {
  record: RunRecord
  varying: string[]
  /** The numeric columns to render, in order — the visible set (KV columns only when shown). */
  numericCols: Column[]
  /** The group-separator class for a column key, tracking the visible column set. */
  sep: (key: string) => string | undefined
  /** The visible column count, for the reproduce row's colSpan. */
  colCount: number
  showModel: boolean
  showHardware: boolean
  /** Whether the Load column is present (the profile spans more than one offered load). */
  showLoad: boolean
  /** Whether this row's reproduce panel is open, and how to flip it. The state lives in
   * the table so the expand-all / collapse-all control can drive every row at once. */
  open: boolean
  onToggleRepro: () => void
  /** Whether this row is the one a reveal is currently highlighting (§7). */
  revealed: boolean
  /** Opens the delete confirmation for this run, or undefined when deletion is not offered. */
  onDelete?: (record: RunRecord) => void
  /** Whether the table is in compare mode: a row-click highlights the run instead of opening
   *  its reproduce panel. */
  compareMode: boolean
  /** Whether this row is highlighted for comparison. */
  highlighted: boolean
  /** Toggle this run's highlight membership (compare mode only). */
  onToggleHighlight?: (runId: string) => void
  /** Whether this is a disqualified run: the row is muted and flagged, and its expanded panel
   *  leads with a why-block (DqWhy) before the blis command. Defaults to false (a ranked row). */
  dq?: boolean
  /** Mean output tokens per served request across the complete runs, passed through to DqWhy for
   *  the size-bias comparison. Only read when dq. */
  completePerReqMean?: number | null
}) {
  const panelId = `repro-${record.group_id}-${record.run_id}`

  const onRowClick = (e: ReactMouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('button, a, [role="note"]')) return
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (sel && !sel.isCollapsed) return
    // In compare mode the row is the selection target: click highlights it for the panel
    // rather than opening the blis command. The reproduce caret is a <button>, so it is
    // excluded above and still opens repro.
    if (compareMode && onToggleHighlight) {
      onToggleHighlight(runKey(record))
      return
    }
    onToggleRepro()
  }

  const rowClass = [revealed ? 'revealed' : '', highlighted ? 'cmphl' : '', dq ? 'dqline' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <tr id={rowId(record)} className={rowClass || undefined} onClick={onRowClick}>
        {showLoad && <LoadCell record={record} />}
        <DeploymentCell
          record={record}
          varying={varying}
          showModel={showModel}
          showHardware={showHardware}
          reproOpen={open}
          onToggleRepro={onToggleRepro}
          reproPanelId={panelId}
          onDelete={onDelete}
          dq={dq}
        />
        {numericCols.map((col) => (
          <ValueCell key={col.key} col={col} record={record} sep={sep} />
        ))}
      </tr>
      {open && (
        <tr className="reprorow">
          <td colSpan={colCount + (showLoad ? 1 : 0)} id={panelId}>
            {dq && <DqWhy record={record} completePerReqMean={completePerReqMean} />}
            <ReproPanel record={record} />
          </td>
        </tr>
      )}
    </>
  )
}

/** At most this many knob chips show before the cell collapses the overflow (D-cell). */
const KNOBS_BEFORE_COLLAPSE = 4

/**
 * The readout's first column: one deployment, top to bottom. The model name leads (only
 * when the table spans more than one model), then the GPU type (only when the table spans
 * more than one), then the key spec line, then the knobs that differ across the group. A
 * resting cell stays short: the fields identical across the group, and any knobs past
 * {@link KNOBS_BEFORE_COLLAPSE}, wait behind "show all".
 */
function DeploymentCell({
  record,
  varying,
  showModel,
  showHardware,
  reproOpen,
  onToggleRepro,
  reproPanelId,
  onDelete,
  dq = false,
}: {
  record: RunRecord
  varying: string[]
  showModel: boolean
  showHardware: boolean
  /** Whether this row's reproduce panel is open, and how to flip it. */
  reproOpen: boolean
  onToggleRepro: () => void
  reproPanelId: string
  /** Opens the delete confirmation for this run, or undefined when deletion is not offered. */
  onDelete?: (record: RunRecord) => void
  /** Whether this is a disqualified run: leads the cell with a ⚠ marker (the row's non-color
   *  flag; the reasons live in the expanded why-block). */
  dq?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const spec = deploymentSpec(record, varying)
  const knobs = expanded ? spec.knobs : spec.knobs.slice(0, KNOBS_BEFORE_COLLAPSE)
  const hidden = spec.knobs.length - knobs.length + spec.rest.length

  // The cell stays a real table-cell so its width tracks the shared column; the flex
  // column that stacks model / hardware / spec / knobs lives on an inner box. Putting
  // `display:flex` on the <td> itself takes it out of the table's column-sizing and
  // lets the body cell shrink-wrap narrower than its header, jagging the frozen
  // column's divider whenever the content is narrower than the column.
  return (
    <td className="lft dep">
      <button
        type="button"
        className="reprotoggle"
        aria-expanded={reproOpen}
        aria-controls={reproPanelId}
        aria-label={`${reproOpen ? 'Hide' : 'Show'} the blis command for ${record.run_id}`}
        onClick={onToggleRepro}
      >
        <span aria-hidden="true">{reproOpen ? '▾' : '▸'}</span>
      </button>
      {onDelete && <DeleteRunButton record={record} onDelete={onDelete} variant="onrow" />}
      <div className="depbox">
        {dq && (
          <span className="dqflag" title="Incomplete (windowed) — expand for why" aria-label="incomplete windowed run">
            ⚠
          </span>
        )}
        {showModel && <span className="dep-model">{record.deployment.model}</span>}
        {showHardware && <span className="dep-hw">{record.deployment.hardware}</span>}

        <span className="dep-key">
          {spec.key.map((p) => (
            <span key={p.field} className="kv">
              <i>{p.field}</i> {p.value}
            </span>
          ))}
        </span>

        {(knobs.length > 0 || (expanded && spec.rest.length > 0)) && (
          <span className="dep-knobs">
            {knobs.map((chip) => (
              <Knob key={chip.label} chip={chip} />
            ))}
            {expanded &&
              spec.rest.map((p) => (
                <Knob
                  key={p.field}
                  rest
                  chip={{ label: p.items ? p.field : `${p.field} ${p.value}`, extra: false, items: p.items }}
                />
              ))}
          </span>
        )}

        {hidden > 0 && (
          <button
            type="button"
            className="dep-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : `Show all (${hidden} more)`}
          </button>
        )}
      </div>
    </td>
  )
}

/** The offered-load cell of a sweep row: the rate (one decimal) or concurrency (integer) this
 *  run was offered, in its own column before the deployment. */
function LoadCell({ record }: { record: RunRecord }) {
  const load = offeredLoad(record.group)
  return (
    <td className="loadcell lcol">
      <span className="val">{formatNumber(load.value, load.kind === 'rate' ? 1 : 0)}</span>
    </td>
  )
}

function ValueCell({
  col,
  record,
  sep,
}: {
  col: Column
  record: RunRecord
  /** The group-separator class for a column key, tracking the visible column set. */
  sep: (key: string) => string | undefined
}) {
  if (col.key === 'gpus') {
    const gpus = gpuCount(record)
    const derived = col.derivedFrom! // gpus always carries a formula, see COLUMNS
    return (
      <td className="gpcol">
        <Derived
          formula={`${derived.formula} = ${record.deployment.tp} × ${record.deployment.num_instances} = ${gpus}. ${derived.note}.`}
        >
          {formatCount(gpus)}
        </Derived>
      </td>
    )
  }
  if (col.key === 'served') {
    const s = servedFraction(record)
    const derived = col.derivedFrom! // served always carries a formula, see COLUMNS
    return (
      <td className={sep(col.key)}>
        <Derived
          formula={`${derived.formula} = ${s.completed} ÷ ${s.injected} = ${s.percent}%. ${derived.note}.`}
        >
          {formatCount(s.completed)}/{formatCount(s.injected)}
        </Derived>
        {s.percent < 100 && <span className="short"> {s.percent}%</span>}
      </td>
    )
  }
  if (col.key === 'preemption_rate') {
    // Derived like served/gpus: BLIS prints this rate to stdout but not the JSON, so it is
    // recomputed from the two counts and marked as derived at the point of display (CLAUDE.md).
    const rate = preemptionRate(record)
    const derived = col.derivedFrom! // preemption_rate always carries a formula, see COLUMNS
    return (
      <td className={sep(col.key)}>
        {rate == null ? (
          // No request completed: the rate is undefined, shown as "—", never a spurious 0.
          <span className="val">{formatNumber(null, col.digits!)}</span>
        ) : (
          <Derived
            formula={`${derived.formula} = ${record.metrics.preemption_count} ÷ ${record.metrics.completed_requests} = ${formatNumber(rate, col.digits!)}. ${derived.note}.`}
          >
            {formatNumber(rate, col.digits!)}
          </Derived>
        )}
      </td>
    )
  }

  const value = col.value(record)
  return (
    <td className={sep(col.key)}>
      <span className="val">
        {col.percent
          ? formatPercent(value)
          : col.digits != null
            ? formatNumber(value, col.digits)
            : formatMs(value)}
      </span>
    </td>
  )
}
