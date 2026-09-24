import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { RunGroup, RunRecord, WorkloadGroup } from '../load'
import { rowId } from '../liverun'
import type { RevealTarget } from '../liverun'
import { formatCount, formatMs, formatNumber } from '../format'
import {
  COLUMNS,
  NUMERIC_COLUMNS,
  deploymentSpec,
  distinctHardware,
  distinctModels,
  gpuCount,
  nextSort,
  removeSort,
  servedFraction,
  sortRecords,
  varyingDeploymentFields,
} from '../model'
import type { Column, SortSpec } from '../model'
import { splitBySlo } from '../slo'
import type { SloTargets } from '../slo'
import { Derived } from './Derived'
import { DeleteRunButton } from './DeleteRunButton'
import { Knob } from './Knob'
import { DqBand } from './DqBand'
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
}

/** True when `hardware` is empty (all) or lists this record's accelerator. */
function keptByHardware(record: RunRecord, hardware: string[]): boolean {
  return hardware.length === 0 || hardware.includes(record.deployment.hardware)
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
}: Props) {
  const showDelete = canDelete && onDelete != null
  const group = workload.groups[0]! // one comparability group per workload since E1
  const [sort, setSort] = useState<SortSpec[]>([])
  // The run_id of the row currently pulsing from a reveal, or null. Local to the table so
  // the highlight lives and dies with the row, not with App's reveal request.
  const [revealedKey, setRevealedKey] = useState<string | null>(null)

  const shown = useMemo(() => new Set(models.length > 0 ? models : workload.models), [models, workload.models])
  const keep = useMemo(
    () => (r: RunRecord) => shown.has(r.deployment.model) && keptByHardware(r, hardware),
    [shown, hardware],
  )
  const complete = useMemo(() => group.complete.filter(keep), [group.complete, keep])
  const disqualified = useMemo(() => group.disqualified.filter(keep), [group.disqualified, keep])
  const records = useMemo(() => group.records.filter(keep), [group.records, keep])

  const varying = useMemo(() => varyingDeploymentFields(records), [records])
  // Only label the model or GPU type when the table holds more than one: a single-model
  // or single-accelerator table already names it in its filter card.
  const showModel = useMemo(() => distinctModels(complete).length > 1, [complete])
  const showHardware = useMemo(() => distinctHardware(complete).length > 1, [complete])
  // The SLO targets split the model/hardware-kept complete runs into the ranked (passing)
  // rows and the ones a target pulled out. The table ranks only the passing rows; the rest
  // go to the SloBand beneath it. With no targets set, passing is the whole set and hidden
  // is empty, so the table is unchanged.
  const { passing, hidden } = useMemo(() => splitBySlo(complete, sloTargets), [complete, sloTargets])
  const rows = useMemo(() => sortRecords(passing, sort), [passing, sort])
  const repro = useReproToggles(rows)
  // The table is replaced by a short note only when a target removed every row, not when the
  // group simply has no complete runs, which renders the empty table as before.
  const allHiddenBySlo = passing.length === 0 && hidden.length > 0

  // The disqualified band works over the same filtered rows, so its would-be rank is
  // computed against exactly the complete runs on screen.
  const filtered: RunGroup = useMemo(
    () => ({ ...group, complete, disqualified, records }),
    [group, complete, disqualified, records],
  )

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
    setRevealedKey(target.run_id)
    const timer = setTimeout(() => {
      setRevealedKey(null)
      onRevealed?.()
    }, 2000)
    return () => clearTimeout(timer)
  }, [revealTarget, records, onRevealed])

  const toggle = (key: string) => setSort(nextSort(sort, key))
  const headerGroups = groupedHeaders()

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
            onRemoveSort={(key) => setSort(removeSort(sort, key))}
            repro={repro}
            showControls={true}
          />

          <div className="tscroll">
            <table className="readout">
              <thead>
                <tr className="grp">
                  {headerGroups.map((h, i) => (
                    <th
                      key={`${h.group}-${i}`}
                      colSpan={h.span}
                      scope="colgroup"
                      className={i > 0 ? 'gsep' : undefined}
                    >
                      {h.group}
                    </th>
                  ))}
                </tr>
                <tr>
                  {COLUMNS.map((col) => (
                    <HeaderCell key={col.key} col={col} sort={sort} onSort={toggle} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <DataRow
                    key={record.run_id}
                    record={record}
                    varying={varying}
                    showModel={showModel}
                    showHardware={showHardware}
                    open={repro.isOpen(record)}
                    onToggleRepro={() => repro.toggle(record)}
                    revealed={revealedKey === record.run_id}
                    onDelete={showDelete ? onDelete : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SloBand hidden={hidden} targets={sloTargets} />

      <DqBand group={filtered} onDelete={showDelete ? onDelete : undefined} />
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
 * The bar above the table: the removable sort chips on the left, the expand/collapse-all
 * control on the right. The expand/collapse-all control is always shown; each button
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
        <ReproControls
          allOpen={repro.allOpen}
          noneOpen={repro.noneOpen}
          onExpandAll={repro.expandAll}
          onCollapseAll={repro.collapseAll}
        />
      )}
    </div>
  )
}

/**
 * The keys of the columns that begin a new group (latency's first column, throughput's
 * first, health's first) — the boundaries a vertical rule sits to the left of. The
 * candidate group is first, so it never carries one; the table's own edge is its left
 * boundary. Derived from COLUMNS so the separators track the grouping, not a hand-kept list.
 */
const GROUP_START_KEYS = new Set(
  COLUMNS.filter((col, i) => i > 0 && col.group !== COLUMNS[i - 1]!.group).map((c) => c.key),
)

/** The separator class for a column, or undefined when it does not start a group. */
function sepClass(key: string): string | undefined {
  return GROUP_START_KEYS.has(key) ? 'gsep' : undefined
}

/** The grouped top header row's colspans, built from COLUMNS' `group` runs. */
function groupedHeaders(): { group: string; span: number }[] {
  const headerGroups: { group: string; span: number }[] = []
  for (const col of COLUMNS) {
    const last = headerGroups[headerGroups.length - 1]
    if (last && last.group === col.group) last.span += 1
    else headerGroups.push({ group: col.group, span: 1 })
  }
  return headerGroups
}

function HeaderCell({
  col,
  sort,
  onSort,
}: {
  col: Column
  sort: SortSpec[]
  onSort: (key: string) => void
}) {
  const sortable = col.key !== 'deployment'
  const idx = sort.findIndex((s) => s.key === col.key)
  const active = idx !== -1
  const dir = active ? sort[idx]!.dir : 1
  // The rank only reads as a rank when more than one column is in play; a lone sort
  // needs no "1" beside its caret.
  const rank = active && sort.length > 1 ? idx + 1 : null
  const className = col.key === 'deployment' ? 'lft' : sepClass(col.key)
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
  showModel,
  showHardware,
  open,
  onToggleRepro,
  revealed,
  onDelete,
}: {
  record: RunRecord
  varying: string[]
  showModel: boolean
  showHardware: boolean
  /** Whether this row's reproduce panel is open, and how to flip it. The state lives in
   * the table so the expand-all / collapse-all control can drive every row at once. */
  open: boolean
  onToggleRepro: () => void
  /** Whether this row is the one a reveal is currently highlighting (§7). */
  revealed: boolean
  /** Opens the delete confirmation for this run, or undefined when deletion is not offered. */
  onDelete?: (record: RunRecord) => void
}) {
  const panelId = `repro-${record.group_id}-${record.run_id}`

  const onRowClick = (e: ReactMouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('button, a, [role="note"]')) return
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (sel && !sel.isCollapsed) return
    onToggleRepro()
  }

  return (
    <>
      <tr id={rowId(record)} className={revealed ? 'revealed' : undefined} onClick={onRowClick}>
        <DeploymentCell
          record={record}
          varying={varying}
          showModel={showModel}
          showHardware={showHardware}
          reproOpen={open}
          onToggleRepro={onToggleRepro}
          reproPanelId={panelId}
          onDelete={onDelete}
        />
        {NUMERIC_COLUMNS.map((col) => (
          <ValueCell key={col.key} col={col} record={record} />
        ))}
      </tr>
      {open && (
        <tr className="reprorow">
          <td colSpan={COLUMNS.length} id={panelId}>
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

function ValueCell({ col, record }: { col: Column; record: RunRecord }) {
  if (col.key === 'gpus') {
    const gpus = gpuCount(record)
    const derived = col.derivedFrom! // gpus always carries a formula, see COLUMNS
    return (
      <td>
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
      <td className={sepClass(col.key)}>
        <Derived
          formula={`${derived.formula} = ${s.completed} ÷ ${s.injected} = ${s.percent}%. ${derived.note}.`}
        >
          {formatCount(s.completed)}/{formatCount(s.injected)}
        </Derived>
        {s.percent < 100 && <span className="short"> {s.percent}%</span>}
      </td>
    )
  }

  const value = col.value(record)
  return (
    <td className={sepClass(col.key)}>
      <span className="val">
        {col.digits != null ? formatNumber(value, col.digits) : formatMs(value)}
      </span>
    </td>
  )
}
