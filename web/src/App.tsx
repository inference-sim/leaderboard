import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { loadCommittedRecords, loadWorkloads } from './load'
import type { RunRecord, WorkloadGroup } from './load'
import { deleteRun, fetchResults } from './results'
import { ReadoutTable } from './components/ReadoutTable'
import { ConfirmDialog } from './components/ConfirmDialog'
import { WorkloadHeader } from './components/SpecHeader'
import { WorkloadPicker } from './components/WorkloadPicker'
import { ModelFilter } from './components/ModelFilter'
import { HardwareFilter } from './components/HardwareFilter'
import { SloFilter } from './components/SloFilter'
import { EmptyFilterNote } from './components/EmptyFilterNote'
import { SLO_METRICS, emptyTargets, parseTargets } from './slo'
import type { RawTargets } from './slo'
import { NewRun } from './components/NewRun'
import { CompareBar } from './components/CompareBar'
import { ComparePanel } from './components/ComparePanel'
import { toggleSelection } from './compare'
import { LiveRunBanner } from './components/LiveRunBanner'
import { Catalog } from './components/Catalog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { emptyFilterNoun } from './filter'
import { initialValues, saveThenRun } from './newrun'
import type { FormValues, Output } from './newrun'
import { runDeclFromOutput, workloadKeyForGroup } from './liverun'
import type { LiveRun, RevealTarget } from './liverun'

type View = 'board' | 'declare' | 'catalog'

// Line icons, stroked in currentColor like the copy glyph, so the rail reads as icons
// alone when collapsed. Each is the accessible name's picture: ranked bars, stacked
// layers, a plus for a new run.
function BoardIcon() {
  return (
    <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 21h18M6 21v-6M12 21V9M18 21v-9" />
    </svg>
  )
}

function DeclareIcon() {
  return (
    <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  )
}

// Catalog: what BLIS can run (models and hardware), a grid of items in the rail's stroke
// vocabulary, distinct from the ranked bars and the workload layers.
function CatalogIcon() {
  return (
    <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

// The GitHub mark is a filled logo, so it drops the rail's stroke for a solid fill in
// currentColor and keeps the same 18px footprint as the stroked icons beside it.
function GithubIcon() {
  return (
    <svg className="navico navico-solid" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.34 9.34 0 0 1 2.5-.35c.85 0 1.71.12 2.5.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  )
}

// BLIS is the simulator this board consumes, a distinct project rather than another view,
// so it gets its own stroked mark: a chip with pins, in the rail's icon vocabulary.
function BlisIcon() {
  return (
    <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2" />
    </svg>
  )
}

const VIEWS: { view: View; hash: string; label: string; icon: ReactNode }[] = [
  { view: 'board', hash: '#/', label: 'Leaderboard', icon: <BoardIcon /> },
  { view: 'catalog', hash: '#/catalog', label: 'Catalog', icon: <CatalogIcon /> },
  { view: 'declare', hash: '#/declare', label: 'Declare a run', icon: <DeclareIcon /> },
]

// The rail's collapsed state is a per-viewer preference, remembered across reloads. A
// blocked or empty store just means it opens expanded, so every access is guarded.
const NAV_KEY = 'blis:nav-collapsed'

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_KEY) === '1'
  } catch {
    return false
  }
}

function viewFromHash(hash: string): View {
  if (hash.startsWith('#/declare')) return 'declare'
  // Catalog holds the Models, Hardware and Workloads tabs. The old top-level #/workloads,
  // #/models and #/hardware links (and the Declare form's workload hand-off) all land on
  // Catalog, which reads the hash to pick its inner tab.
  if (
    hash.startsWith('#/catalog') ||
    hash.startsWith('#/models') ||
    hash.startsWith('#/hardware') ||
    hash.startsWith('#/workloads')
  )
    return 'catalog'
  return 'board'
}

export function App() {
  // The committed results are inlined at build time, so the page has data even with
  // no server. When `leaderboard serve` is up, its live results supersede them, so a
  // run made this session appears on the board without a rebuild.
  const committed = useMemo(() => loadCommittedRecords(), [])
  const [records, setRecords] = useState<RunRecord[]>(committed)
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash))
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  // Whether the run server is reachable. Deleting a run removes its results file from
  // disk, which only `leaderboard serve` can do, so this gates the per-run delete control:
  // the static committed board (no server) shows no trash button. It starts false and is
  // set the first time /api/results answers.
  const [serverAvailable, setServerAvailable] = useState(false)
  // The run awaiting a delete confirmation, and the last delete failure to show. The
  // confirmation and the destructive call live here at the root, beside the records and the
  // live run a delete may have to clear, rather than in the table that renders the button.
  const [pendingDelete, setPendingDelete] = useState<RunRecord | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // The run and the form both live here, at the root that stays mounted across every view
  // switch (§4). NewRun unmounts the moment Run is clicked and the user lands on the board,
  // so if these lived in NewRun the in-flight fetch would be orphaned and a failed run's
  // form lost. `liveRun` is the one run in flight or just landed; `formValues` is the
  // Declare form, so a bounce back after a failure finds it exactly as it was left.
  const [liveRun, setLiveRun] = useState<LiveRun>(null)
  const [formValues, setFormValues] = useState<FormValues>(initialValues)
  // Whether NewRun has already applied its one-time catalog default to `workloadSel`. It
  // lives here, with the form, so a remount after a failed run does not re-run that default
  // and clobber the workload the reader had chosen.
  const [workloadInitialized, setWorkloadInitialized] = useState(false)
  // Whether the reader has taken over the run id. It lives here, with the form, so the
  // descriptive auto-id keeps syncing until they type their own, and a remount after a
  // failed run does not resume syncing over the id they had chosen.
  const [runIdEdited, setRunIdEdited] = useState(false)
  // Whether the reader has taken over the custom workload's name, alongside runIdEdited and
  // for the same reason: the suggested custom-N keeps syncing against the catalog until they
  // type their own, and a remount after a failed run does not resume over the name they chose.
  const [customNameEdited, setCustomNameEdited] = useState(false)
  // Which workload the board shows, lifted from Leaderboard so a reveal can select the one
  // that holds the target row. null falls back to the first workload.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // A pending "scroll to and highlight this row" request, set by the banner's View the run.
  const [revealTarget, setRevealTarget] = useState<RevealTarget | null>(null)

  const toggleNav = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(NAV_KEY, next ? '1' : '0')
      } catch {
        // No store (private window, blocked): the choice just does not persist.
      }
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    try {
      setRecords(await fetchResults())
      // The server answered, so its live results supersede the committed build and the
      // delete control can be offered.
      setServerAvailable(true)
    } catch {
      // No server: the committed build stands, and delete stays hidden. This is the normal
      // static case.
      setServerAvailable(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const onReveal = useCallback((record: RunRecord) => {
    setRevealTarget({ groupId: record.group_id, runId: record.run_id })
  }, [])
  const onRevealed = useCallback(() => setRevealTarget(null), [])

  // Declaring a run: move to the board at once so the run is watched where its result
  // belongs (§5), then drive the single blocking POST from here, where the fetch survives
  // NewRun unmounting. A custom (distribution) workload is first saved to the catalog so it
  // can be reused (saveThenRun); a save failure aborts before the run, so a workload that
  // could not be saved is never run. On success, reload first so the new row is in a
  // rendered table, then reveal it straight away: the reader landed on the board to see this
  // run, so on first arrival we select its table, reset the filters, and pulse the row for a
  // couple of seconds without waiting for a "View the run" click. The banner's button
  // remains, so the reveal can be replayed once the highlight has faded. On failure, bounce
  // back to Declare with blis's own message (or the save error) and the form intact.
  const startRun = useCallback(
    async (output: Output) => {
      const decl = runDeclFromOutput(output)
      setLiveRun({ status: 'running', decl })
      window.location.hash = '#/'
      try {
        const record = await saveThenRun(output)
        await reload()
        setLiveRun({ status: 'done', decl, record })
        onReveal(record)
      } catch (e) {
        setLiveRun({ status: 'error', decl, message: e instanceof Error ? e.message : String(e) })
        window.location.hash = '#/declare'
      }
    },
    [reload, onReveal],
  )

  // A row's trash button asks to delete a run; the actual removal waits on the confirmation
  // modal, so a stray click cannot carry out an irreversible delete. Opening the dialog
  // clears any prior failure note so it does not linger over a fresh attempt.
  const requestDelete = useCallback((record: RunRecord) => {
    setDeleteError(null)
    setPendingDelete(record)
  }, [])

  // Confirmed: delete the run's results file, then reload so the row leaves the board. If the
  // just-deleted run is the one the banner is showing, clear the banner too — its record no
  // longer exists. A failure keeps the row and surfaces the server's message.
  const confirmDelete = useCallback(async () => {
    const record = pendingDelete
    if (!record) return
    setPendingDelete(null)
    try {
      await deleteRun(record.group_id, record.run_id)
      await reload()
      setLiveRun((cur) =>
        cur?.status === 'done' &&
        cur.record.group_id === record.group_id &&
        cur.record.run_id === record.run_id
          ? null
          : cur,
      )
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }, [pendingDelete, reload])

  // The hash is the route, so the back button works and a table can be linked to.
  useEffect(() => {
    const sync = () => setView(viewFromHash(window.location.hash))
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const workloads = useMemo(() => loadWorkloads(records), [records])
  // NewRun takes the board's flat comparability groups for target detection and the flags
  // basis; it fetches the workload catalog it now selects from on its own.
  const groups = useMemo(() => workloads.flatMap((w) => w.groups), [workloads])

  return (
    <div className="app">
      <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
        <button
          type="button"
          className="navtoggle"
          onClick={toggleNav}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <nav className="sidenav" aria-label="Views">
          {VIEWS.map((v) => (
            <a
              key={v.view}
              href={v.hash}
              aria-current={view === v.view ? 'page' : undefined}
              aria-label={v.label}
              title={collapsed ? v.label : undefined}
            >
              {v.icon}
              <span className="navlabel">{v.label}</span>
            </a>
          ))}
        </nav>
        <div className="railfoot">
          <a
            href="https://github.com/inference-sim/leaderboard"
            target="_blank"
            rel="noreferrer"
            aria-label="Leaderboard source on GitHub"
            title={collapsed ? 'Leaderboard source on GitHub' : undefined}
          >
            <GithubIcon />
            <span className="navlabel">Source</span>
          </a>
          <a
            href="https://github.com/inference-sim/inference-sim/"
            target="_blank"
            rel="noreferrer"
            aria-label="BLIS simulator on GitHub"
            title={collapsed ? 'BLIS simulator on GitHub' : undefined}
          >
            <BlisIcon />
            <span className="navlabel">BLIS</span>
          </a>
        </div>
      </aside>

      <main className="content">
        <div className="wrap">
          <header className="masthead">
            <h1>BLIS Leaderboard</h1>
            <p className="dek">
              Compare simulated LLM inference performance across models, hardware, and serving
              configurations.
            </p>
          </header>

          {/* A crash in any one view shows a contained message instead of blanking the whole
              app; keyed by view so switching tabs clears it. */}
          <ErrorBoundary resetKey={view}>
            {view === 'declare' ? (
              <NewRun
                groups={groups}
                values={formValues}
                onChange={setFormValues}
                workloadInitialized={workloadInitialized}
                onWorkloadInitialized={() => setWorkloadInitialized(true)}
                runIdEdited={runIdEdited}
                onRunIdEdited={() => setRunIdEdited(true)}
                customNameEdited={customNameEdited}
                onCustomNameEdited={() => setCustomNameEdited(true)}
                running={liveRun?.status === 'running'}
                errorMessage={liveRun?.status === 'error' ? liveRun.message : null}
                onRun={startRun}
              />
            ) : view === 'catalog' ? (
              <Catalog boardWorkloads={workloads} />
            ) : (
              <>
                {(liveRun?.status === 'running' || liveRun?.status === 'done') && (
                  <LiveRunBanner
                    liveRun={liveRun}
                    onDismiss={() => setLiveRun(null)}
                    onReveal={onReveal}
                  />
                )}
                {deleteError && (
                  <p className="dek issue" role="alert">
                    {deleteError}
                  </p>
                )}
                <Leaderboard
                  workloads={workloads}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  revealTarget={revealTarget}
                  onRevealed={onRevealed}
                  canDelete={serverAvailable}
                  onDelete={requestDelete}
                />
              </>
            )}
          </ErrorBoundary>
        </div>
      </main>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete run?"
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      >
        Delete <code className="mono">{pendingDelete?.run_id}</code>? This permanently removes its
        result from <code>results/</code> on disk. Re-run the same declaration to bring it back.
      </ConfirmDialog>
    </div>
  )
}

function Leaderboard({
  workloads,
  selectedKey,
  onSelect,
  revealTarget,
  onRevealed,
  canDelete,
  onDelete,
}: {
  workloads: WorkloadGroup[]
  /** Which workload is shown, lifted to App so a reveal can select the target's table.
   * Keyed by workloadKey so a live reload that adds runs keeps the same workload selected
   * when it is still present, and falls back to the first when it is not. */
  selectedKey: string | null
  onSelect: Dispatch<SetStateAction<string | null>>
  revealTarget: RevealTarget | null
  onRevealed: () => void
  /** Whether the per-run delete control is offered (the run server is reachable). */
  canDelete: boolean
  /** Opens the delete confirmation for a run. */
  onDelete: (record: RunRecord) => void
}) {
  const selected =
    workloads.find((w) => w.workloadKey === selectedKey) ?? workloads[0] ?? null

  // Bumped on each reveal and folded into the section key, so the section remounts and its
  // model and hardware filters reset to all, so the target row can never be hidden behind a
  // filter the reader left narrowed (§7).
  const [revealNonce, setRevealNonce] = useState(0)
  useEffect(() => {
    if (!revealTarget) return
    // A run lands in exactly one workload (E1), so its group_id names the table to show.
    const key = workloadKeyForGroup(workloads, revealTarget.groupId)
    if (key && key !== selectedKey) onSelect(key)
    setRevealNonce((n) => n + 1)
    // revealTarget alone: it is set fresh on each View the run click, and the values read
    // here are current in that render's closure. Re-running when selectedKey then changes
    // would only remount the section a second time for no gain.
  }, [revealTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  if (workloads.length === 0) {
    return (
      <>
        <p className="dek">
          Nothing in <code>results/</code> yet. <a href="#/declare">Declare a run</a> to get a
          runs.yaml, then <code>make blis &amp;&amp; ./bin/leaderboard run</code> to fill this
          page.
        </p>
      </>
    )
  }

  return (
    <>
      <WorkloadPicker
        workloads={workloads}
        selected={selected!.workloadKey}
        onSelect={onSelect}
      />

      {selected && (
        <WorkloadSection
          key={`${selected.workloadKey}:${revealNonce}`}
          workload={selected}
          revealTarget={revealTarget}
          onRevealed={onRevealed}
          canDelete={canDelete}
          onDelete={onDelete}
        />
      )}
    </>
  )
}

/**
 * One workload section: its header, the model and hardware filters, and the table. The
 * section owns both selections (nothing is routed through the URL hash this iteration).
 * Each selection is the literal set of options shown and starts at every option, so an
 * untouched section shows everything; deselecting all of one filter is a real "show
 * nothing" state, and the section renders a note pointing back to it rather than a blank
 * table. Model and hardware are both candidates now (E1), so both selections only narrow
 * the rows ReadoutTable renders; neither changes the table or asserts a ranking. Keyed by
 * workloadKey in Leaderboard, so switching workloads mounts a fresh section with both
 * filters reset to all. The key also carries a reveal nonce, so revealing a run remounts
 * the section and resets its filters, keeping the target row from hiding behind one.
 */
function WorkloadSection({
  workload,
  revealTarget,
  onRevealed,
  canDelete,
  onDelete,
}: {
  workload: WorkloadGroup
  revealTarget: RevealTarget | null
  onRevealed: () => void
  canDelete: boolean
  onDelete: (record: RunRecord) => void
}) {
  // The accelerators actually present in this workload, sorted. Hardware is a candidate
  // under test rather than part of the key, so it is read from the records, not the group.
  const hardwareTypes = useMemo(
    () => [...new Set(workload.records.map((r) => r.deployment.hardware))].sort(),
    [workload],
  )
  const [models, setModels] = useState<string[]>(workload.models)
  const [hardware, setHardware] = useState<string[]>(hardwareTypes)
  // The SLO targets, raw as the form holds them. They live in this same section state, so
  // the reveal remount (the key carries a nonce) resets them to empty alongside the model
  // and hardware selections, so a freshly run candidate can never be hidden behind a target
  // the reader left set. Parsed at the point they are handed to the table.
  const [sloTargets, setSloTargets] = useState<RawTargets>(emptyTargets)
  // Compare mode and the highlighted run_ids live here, beside the filters, so they reset on
  // the same remount boundaries (workload switch, reveal nonce). Selection is keyed by run_id
  // over the whole workload's records, so narrowing a filter never drops a highlighted run.
  const [compareMode, setCompareMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onToggleHighlight = useCallback(
    (runId: string) => setSelectedIds((cur) => toggleSelection(cur, runId)),
    [],
  )
  const highlighted = useMemo(
    () =>
      selectedIds
        .map((id) => workload.records.find((r) => r.run_id === id))
        .filter((r): r is RunRecord => r != null),
    [selectedIds, workload.records],
  )
  // Show a filter whenever the workload has any option for it, not just two or more. The
  // table omits the model and hardware labels when there is only one of each (a single-
  // model table has no Model column, a single-accelerator one no hardware cell), so the
  // filter card is the only place that names them — hiding it at one option would drop
  // that identity from the section entirely.
  const showModels = workload.models.length > 0
  const showHardware = hardwareTypes.length > 0
  const emptyNoun = emptyFilterNoun(showModels, models, showHardware, hardware)
  return (
    <section className={compareMode ? 'group comparing' : 'group'}>
      <WorkloadHeader workload={workload} />
      {compareMode && (
        <p className="cmphint" role="status">
          Compare mode is on. Click rows to highlight them for comparison.
        </p>
      )}
      {(showModels || showHardware) && (
        <div className="filters">
          {showModels && (
            <ModelFilter models={workload.models} selected={models} onChange={setModels} />
          )}
          {showHardware && (
            <HardwareFilter options={hardwareTypes} selected={hardware} onChange={setHardware} />
          )}
          <SloFilter metrics={SLO_METRICS} targets={sloTargets} onChange={setSloTargets} />
        </div>
      )}
      {emptyNoun ? (
        <EmptyFilterNote noun={emptyNoun} />
      ) : (
        <ReadoutTable
          workload={workload}
          models={models}
          hardware={hardware}
          sloTargets={parseTargets(sloTargets)}
          revealTarget={revealTarget}
          onRevealed={onRevealed}
          canDelete={canDelete}
          onDelete={onDelete}
          compareMode={compareMode}
          selectedIds={selectedIds}
          onToggleHighlight={onToggleHighlight}
        />
      )}
      {compareMode && <ComparePanel records={highlighted} onRemove={onToggleHighlight} />}
      <CompareBar
        active={compareMode}
        count={selectedIds.length}
        onToggle={() => {
          // Leaving compare mode clears the highlight selection and hides the panel.
          setCompareMode((on) => {
            if (on) setSelectedIds([])
            return !on
          })
        }}
      />
    </section>
  )
}
