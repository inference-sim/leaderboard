import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { loadCommittedRecords, loadWorkloads, mergeRecords, runKey } from './load'
import type { RunRecord, WorkloadGroup } from './load'
import { deleteRun, fetchResults } from './results'
import { ReadoutTable } from './components/ReadoutTable'
import { ConfirmDialog } from './components/ConfirmDialog'
import { WorkloadHeader } from './components/SpecHeader'
import { WorkloadPicker } from './components/WorkloadPicker'
import { CardGallery } from './components/CardGallery'
import { ModelFilter } from './components/ModelFilter'
import { HardwareFilter } from './components/HardwareFilter'
import { LoadFilter } from './components/LoadFilter'
import { SloFilter } from './components/SloFilter'
import { EmptyFilterNote } from './components/EmptyFilterNote'
import { SLO_METRICS, emptyTargets, parseTargets } from './slo'
import type { RawTargets } from './slo'
import { NewRun } from './components/NewRun'
import { groupSweeps, initSweepRun, mintSweepId, runPool, sweepHasVariation } from './sweep'
import type { SweepAxes, SweepCell, SweepEntry, SweepRun } from './sweep'
import { CompareBar } from './components/CompareBar'
import { ComparePanel } from './components/ComparePanel'
import { selectionInDisplayOrder, toggleSelection } from './compare'
import { nextSort, removeSort } from './model'
import type { SortSpec } from './model'
import { visibleOrder, visibleRows } from './rows'
import { LiveRunBanner } from './components/LiveRunBanner'
import { Toast } from './components/Toast'
import { Catalog } from './components/Catalog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RailVersion } from './components/RailVersion'
import { fetchVersion } from './version'
import type { Versions } from './version'
import { emptyFilterNoun, showLoadFilter } from './filter'
import { initialValues, postRun, saveThenRun } from './newrun'
import type { FormValues, Output } from './newrun'
import { saveWorkload } from './workloads'
import type { ProfileBody } from './workloads'
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

// blis-catalog is the third project the board stands on (the model catalog repo), so it gets
// its own stroked mark alongside Source and BLIS: stacked sheets, the collection it holds.
// Distinct from the main nav's grid CatalogIcon (which marks the in-app Catalog view).
function CatalogRepoIcon() {
  return (
    <svg className="navico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 3 8l9 4 9-4-9-4zM3 12l9 4 9-4M3 16l9 4 9-4" />
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
  // The deployment versions for the footer, or null when there is no /api/version to answer
  // (the static committed board served with no backend, or a serve too old to have the route).
  // Null hides the footer entirely, so the static build is visually unchanged.
  const [versions, setVersions] = useState<Versions | null>(null)
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
  // The "workload added to the catalog" confirmation. Shown when a run's declaration saved a
  // new custom workload (canView: offer a jump to the catalog, since the user is on the board)
  // or when the Catalog's own editor saved one (canView false: the reader is already there and
  // the row is highlighted in place). It lives here, at the root that outlives the submit
  // redirect, so the toast floats over whatever view the user lands on. null means no toast.
  const [catalogToast, setCatalogToast] = useState<{ name: string; canView: boolean } | null>(null)
  // The saved workload the Catalog's Workloads tab should scroll to and highlight, set by the
  // toast's "View in catalog". Cleared once the highlight has shown (onWorkloadRevealed).
  const [revealWorkload, setRevealWorkload] = useState<string | null>(null)
  // Declaration mode for NewRun: a single run or a sweep. Lifted here so it survives the
  // navigation to the board, like formValues. It holds the toggle state that drives the sweep
  // controls, preview, and progress panel (all wired through NewRun) and the sweep inputs below.
  const [mode, setMode] = useState<'single' | 'sweep'>('single')
  // The per-axis chosen values for a sweep (keyed by sweepable field), empty until the reader
  // picks any. Lifted alongside formValues so a bounce back after a run finds them intact.
  const [sweepAxes, setSweepAxes] = useState<SweepAxes>({})
  // The offered-load values a sweep varies over, as strings. Empty collapses to the single
  // run's own loadValue.
  const [loadValues, setLoadValues] = useState<string[]>([])
  // The optional user-chosen name for the next sweep, bound to the "Sweep name" field shown in
  // sweep mode. It is not a swept axis; it rides onto every cell's record as sweep_label.
  // Lifted here beside the other sweep inputs so a bounce back after a run finds it intact.
  const [sweepName, setSweepName] = useState('')
  // The board's top-level tab: the workload gallery (default) or the By-sweep list. Lifted so a
  // navigation away and back keeps the reader on the lens they chose.
  const [boardTab, setBoardTab] = useState<'workload' | 'sweep'>('workload')
  // The sweep whose scoped table is shown, or null for the By-sweep list. Selecting a sweep in
  // the list sets it; the back affordance clears it.
  const [selectedSweepId, setSelectedSweepId] = useState<string | null>(null)
  // The in-flight (or finished) sweep run, or null when no sweep has started.
  const [sweepRun, setSweepRun] = useState<SweepRun | null>(null)
  // A sweep's up-front workload save failed, so no cell ran. Surfaced in the sweep column
  // (the single run's "Did not run" aside is not rendered in sweep mode). null means no error.
  const [sweepError, setSweepError] = useState<string | null>(null)
  // Set true by stopSweep to halt firing new cells; read by runPool's shouldStop. A ref, not
  // state, so the running pool sees the change without a re-render closure capturing a stale
  // value. Reset at the start of each runSweep.
  const stopRef = useRef(false)
  // Coalesces the per-cell reloads: each landed cell schedules one reload ~300ms out, clearing
  // the prior timer, so a burst of cells triggers one fetch rather than one per cell.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Guards runSweep against a double-fire during its up-front saveWorkload await: because
  // sweepRun is set only after the save resolves, a second click in that window would start a
  // second save of the same profile (the duplicate-profile race the save-once design prevents).
  const startingRef = useRef(false)

  // Flips the declaration mode. Switching sweep -> single collapses the sweep inputs back to
  // the single run's own load, so a later re-entry into sweep mode starts clean; the collapse
  // is conditional on the sweep having varied, and NewRun opens its confirm dialog before
  // asking for it. Entering sweep mode seeds the load axis with the single run's own load as
  // its first (base) level when it is still empty, so the base load is present and shown first,
  // symmetric with the collapse and with how the deployment axes carry their base value first.
  const changeMode = useCallback(
    (next: 'single' | 'sweep') => {
      if (next === 'single' && sweepHasVariation(formValues, sweepAxes, loadValues)) {
        setSweepAxes({})
        setLoadValues([formValues.loadValue])
      }
      if (next === 'sweep' && loadValues.length === 0) {
        setLoadValues([formValues.loadValue])
      }
      setMode(next)
    },
    [formValues, sweepAxes, loadValues],
  )

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
      // Merge, not replace: the server's outDir may not be the tree the bundle was built
      // from (the default ~/leaderboard-results holds only this session's runs), so the
      // committed baseline must be kept and the live results layered over it.
      setRecords(mergeRecords(committed, await fetchResults()))
      // The server answered, so its live results are authoritative where they exist and the
      // delete control can be offered.
      setServerAvailable(true)
    } catch {
      // No server: the committed build stands, and delete stays hidden. This is the normal
      // static case.
      setServerAvailable(false)
    }
  }, [committed])

  useEffect(() => {
    reload()
  }, [reload])

  // Fetch the deployment versions once on mount, the same way results are fetched. A
  // rejection (no server, or a serve predating the route) leaves `versions` null and the
  // footer unrendered, mirroring how a dead server hides the delete affordance.
  useEffect(() => {
    fetchVersion()
      .then(setVersions)
      .catch(() => setVersions(null))
  }, [])

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
        // A new custom workload is saved to the catalog before the run. Confirm that the
        // instant the save lands (onSaved), independent of the run's own outcome: the
        // workload is in the catalog from then on either way.
        const record = await saveThenRun(output, {
          onSaved: (name) => setCatalogToast({ name, canView: true }),
        })
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

  // Running a sweep: save the one shared custom workload up front (once, like startRun), then
  // move to the board and fan the cells out through a bounded pool. Each cell posts the same
  // /api/run a single run does; its status lands back in sweepRun and a debounced reload brings
  // the new rows onto the board as they finish. A save failure aborts before any cell runs, so
  // a workload that could not be saved never produces runs.
  const debouncedReload = useCallback(() => {
    clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      reload()
    }, 300)
  }, [reload])

  const runSweep = useCallback(
    async (runs: SweepCell[], saveProfile: ProfileBody | null) => {
      // Re-entry guard: a double-click during the saveWorkload await below must not start a
      // second save/run of the same sweep. Cleared in finally once the pool resolves or throws.
      if (startingRef.current) return
      startingRef.current = true
      try {
        setSweepError(null)
        if (saveProfile) {
          try {
            await saveWorkload(saveProfile, null)
          } catch (e) {
            // The shared workload could not be saved; do not run any cell, and surface why.
            setSweepError(e instanceof Error ? e.message : String(e))
            return
          }
          setCatalogToast({ name: saveProfile.name, canView: true })
        }
        const run = initSweepRun(runs)
        setSweepRun(run)
        stopRef.current = false
        // Mint the sweep's id once, here on the Run click (a preview that is never run mints
        // none). Every cell posts the same id, plus the optional name as sweep_label, so the
        // whole matrix is one addressable sweep on the board.
        const sweepId = mintSweepId()
        const sweepRef = { id: sweepId, label: sweepName.trim() || undefined }
        // Stay on the Declare page so the reader watches the live progress panel (the spec's
        // intent). The board still refreshes underneath via the debounced reload, and each landed
        // cell offers a view-on-board link, so there is no need to jump away.
        await runPool(run.cells, (cell) => postRun(cell.output, undefined, sweepRef), {
          onUpdate: (i, patch) => {
            setSweepRun((prev) =>
              prev ? { ...prev, cells: prev.cells.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : prev,
            )
            debouncedReload()
          },
          shouldStop: () => stopRef.current,
        })
        // Settle: one final reload once the pool has drained, so the board reflects every landed
        // cell even if the last debounce was superseded.
        reload()
      } finally {
        startingRef.current = false
      }
    },
    [reload, debouncedReload, sweepName],
  )

  // Stop the in-flight sweep: no new cells fire (the ref the pool reads), and the panel flips to
  // its stopped state; cells already in flight finish.
  const stopSweep = useCallback(() => {
    stopRef.current = true
    setSweepRun((r) => (r ? { ...r, stopped: true } : r))
  }, [])

  // Clear a finished (or stopped) sweep so the progress panel gives way to the preview and its
  // Run button, letting the reader run another sweep. The axes and load values are left intact,
  // so the matrix persists and running again is one click; only the completed run and any error
  // are dropped.
  const resetSweep = useCallback(() => {
    setSweepRun(null)
    setSweepError(null)
  }, [])

  // The progress panel's per-cell "view on board" control: reveal that landed row the same way
  // the live-run banner does, routing to the board so it scrolls and pulses.
  const onViewRow = useCallback((groupId: string, runId: string) => {
    setRevealTarget({ groupId, runId })
    window.location.hash = '#/'
  }, [])

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
  // The sweeps present on the board, grouped by sweep_id, newest-first. Drives the By-sweep
  // tab's list and the scoped view's lookup. Runs without a sweep_id never appear here.
  const sweepEntries = useMemo(() => groupSweeps(records), [records])
  // The sweep whose section the By-sweep tab shows: the reader's pick when it is still present,
  // else the first sweep (newest), so the tab opens on a sweep the way By workload opens on the
  // first workload. null only when there are no sweeps at all.
  const selectedSweep =
    sweepEntries.find((e) => e.sweepId === selectedSweepId) ?? sweepEntries[0] ?? null

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
        {/* The three projects the board stands on, each linking to its repo. The deployment
            version of each (from /api/version) rides beside its name as small muted text,
            rendered only when a server answered — the static build shows the links alone.
            Both the label and the version drop out when the rail collapses to icons (CSS). */}
        <div className="railfoot">
          <a
            href="https://github.com/inference-sim/leaderboard"
            target="_blank"
            rel="noreferrer"
            aria-label="Leaderboard source on GitHub"
            title={collapsed ? 'Leaderboard source on GitHub' : undefined}
          >
            <GithubIcon />
            <span className="navlabel">leaderboard</span>
            {versions && <RailVersion value={versions.leaderboard} />}
          </a>
          <a
            href="https://github.com/inference-sim/inference-sim/"
            target="_blank"
            rel="noreferrer"
            aria-label="BLIS simulator on GitHub"
            title={collapsed ? 'BLIS simulator on GitHub' : undefined}
          >
            <BlisIcon />
            <span className="navlabel">inference-sim</span>
            {versions && <RailVersion value={versions.blis} />}
          </a>
          <a
            href="https://github.com/inference-sim/blis-catalog"
            target="_blank"
            rel="noreferrer"
            aria-label="BLIS model catalog on GitHub"
            title={collapsed ? 'BLIS model catalog on GitHub' : undefined}
          >
            <CatalogRepoIcon />
            <span className="navlabel">blis-catalog</span>
            {versions && <RailVersion value={versions.catalog} />}
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
                mode={mode}
                onModeChange={changeMode}
                sweepAxes={sweepAxes}
                onSweepAxesChange={setSweepAxes}
                loadValues={loadValues}
                onLoadValuesChange={setLoadValues}
                sweepName={sweepName}
                onSweepNameChange={setSweepName}
                sweepRun={sweepRun}
                onRunSweep={runSweep}
                onStopSweep={stopSweep}
                onResetSweep={resetSweep}
                onViewRow={onViewRow}
                sweepError={sweepError}
              />
            ) : view === 'catalog' ? (
              <Catalog
                boardWorkloads={workloads}
                revealWorkload={revealWorkload}
                onWorkloadRevealed={() => setRevealWorkload(null)}
                onWorkloadSaved={(name) => setCatalogToast({ name, canView: false })}
                onBoardChanged={reload}
              />
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
                <BoardTabs tab={boardTab} onTab={setBoardTab} />
                {boardTab === 'workload' ? (
                  <Leaderboard
                    workloads={workloads}
                    selectedKey={selectedKey}
                    onSelect={setSelectedKey}
                    revealTarget={revealTarget}
                    onRevealed={onRevealed}
                    canDelete={serverAvailable}
                    onDelete={requestDelete}
                  />
                ) : (
                  // By sweep mirrors By workload: the sweep gallery is the picker, and the
                  // selected sweep's section sits below it. The first sweep is selected by
                  // default (selectedSweep falls back to the first), exactly as the workload
                  // tab opens on the first workload.
                  <>
                    <SweepList
                      entries={sweepEntries}
                      selected={selectedSweep?.sweepId ?? null}
                      onSelect={setSelectedSweepId}
                    />
                    {selectedSweep && (
                      <SweepScope
                        key={selectedSweep.sweepId}
                        records={records}
                        entry={selectedSweep}
                        revealTarget={revealTarget}
                        onRevealed={onRevealed}
                        canDelete={serverAvailable}
                        onDelete={requestDelete}
                      />
                    )}
                  </>
                )}
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

      {catalogToast && (
        <Toast
          workloadName={catalogToast.name}
          onView={
            catalogToast.canView
              ? () => {
                  // Set the reveal target first, then route to the Workloads catalog: the tab
                  // is the default under #/catalog, so it opens there and the target is already
                  // set when it mounts. (A save made inside the catalog passes canView false,
                  // so no action is offered: the row is already highlighted in place.)
                  setRevealWorkload(catalogToast.name)
                  setCatalogToast(null)
                  window.location.hash = '#/catalog'
                }
              : undefined
          }
          onDismiss={() => setCatalogToast(null)}
        />
      )}
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
  // The offered-load levels shown, seeded to every level in the profile. Lives in the same
  // section state, so the reveal remount resets it alongside model and hardware. Only a sweep
  // (more than one level) shows the Load filter and the table's Load column.
  const [loads, setLoads] = useState<number[]>(workload.loadAxis.values)
  // The SLO targets, raw as the form holds them. They live in this same section state, so
  // the reveal remount (the key carries a nonce) resets them to empty alongside the model
  // and hardware selections, so a freshly run candidate can never be hidden behind a target
  // the reader left set. Parsed at the point they are handed to the table.
  const [sloTargets, setSloTargets] = useState<RawTargets>(emptyTargets)
  // The table's sort lives here, not in the table, so the Compare panel can open its columns in
  // the very order the table shows. Resets on the section's remount (workload switch, reveal
  // nonce) like the filters, so nothing is ordered by load until the reader clicks (D3).
  const [sort, setSort] = useState<SortSpec[]>([])
  // Compare mode and the highlighted run keys live here, beside the filters, so they reset on
  // the same remount boundaries (workload switch, reveal nonce). Selection is keyed by runKey
  // over the whole workload's records, so narrowing a filter never drops a highlighted run.
  const [compareMode, setCompareMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onToggleHighlight = useCallback(
    (runId: string) => setSelectedIds((cur) => toggleSelection(cur, runId)),
    [],
  )
  // The rows as the table displays them — one shared computation the table and this section both
  // read, so the Compare column order cannot drift from the visible table order.
  const displayOrder = useMemo(
    () => visibleOrder(visibleRows(workload, models, hardware, loads, parseTargets(sloTargets), sort)),
    [workload, models, hardware, loads, sloTargets, sort],
  )
  // The comparison opens in exactly the table's order (ranked rows, then the SLO and disqualified
  // bands): the top row is the control and the columns read down the table — never click order.
  const highlighted = useMemo(
    () => selectionInDisplayOrder(displayOrder, selectedIds),
    [displayOrder, selectedIds],
  )
  // Show a filter whenever the workload has any option for it, not just two or more. The
  // table omits the model and hardware labels when there is only one of each (a single-
  // model table has no Model column, a single-accelerator one no hardware cell), so the
  // filter card is the only place that names them — hiding it at one option would drop
  // that identity from the section entirely.
  const showModels = workload.models.length > 0
  const showHardware = hardwareTypes.length > 0
  // A single load level names itself in the header, so the Load filter (like the table's Load
  // column) appears only for a sweep across two or more levels.
  // The Load filter shows for a sweep, and also for a single-level concurrency (a trace's
  // session pool, even one concurrent session), so a trace's offered load is always a filter.
  const showLoad = showLoadFilter(workload.loadAxis)
  const emptyNoun = emptyFilterNoun(showModels, models, showHardware, hardware, showLoad, loads)
  // Select-all pulls in exactly the runs the model and hardware filters leave on screen (the
  // ranked rows, any SLO-banded ones, and the disqualified band), in declared order; Clear
  // empties the comparison. It tracks the filters so selecting all after narrowing them can
  // never reach a run that is no longer shown. When a filter is emptied outright the table is
  // replaced by a note and nothing is on screen, so the set is empty.
  const allIds = useMemo(
    () => (emptyNoun ? [] : displayOrder.map((r) => runKey(r))),
    [emptyNoun, displayOrder],
  )
  const onSelectAll = useCallback(() => setSelectedIds(allIds), [allIds])
  const onClearSelection = useCallback(() => setSelectedIds([]), [])
  return (
    <section className="group">
      {/* Compare mode draws an indigo frame around the whole viewport with a corner flag, so
          it is unmistakable the board is in another mode without recolouring the content. */}
      {compareMode && (
        <div className="cmpframe" aria-hidden="true">
          <span className="cmpframe-flag">Compare mode</span>
        </div>
      )}
      <WorkloadHeader workload={workload} />
      {showLoad && (
        <div className="filters loadrow">
          <LoadFilter
            kind={workload.loadAxis.kind}
            options={workload.loadAxis.values}
            selected={loads}
            onChange={setLoads}
          />
        </div>
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
          loads={loads}
          sloTargets={parseTargets(sloTargets)}
          revealTarget={revealTarget}
          onRevealed={onRevealed}
          canDelete={canDelete}
          onDelete={onDelete}
          compareMode={compareMode}
          selectedIds={selectedIds}
          onToggleHighlight={onToggleHighlight}
          sort={sort}
          onSort={(key) => setSort((cur) => nextSort(cur, key))}
          onRemoveSort={(key) => setSort((cur) => removeSort(cur, key))}
        />
      )}
      {compareMode && <ComparePanel records={highlighted} onRemove={onToggleHighlight} />}
      <CompareBar
        active={compareMode}
        count={selectedIds.length}
        total={allIds.length}
        onSelectAll={onSelectAll}
        onClear={onClearSelection}
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

/**
 * The board's two-tab control: By workload (the gallery, the default) and By sweep (the list
 * of sweeps). It reuses the Catalog's subtab vocabulary so the two tab bars read the same.
 */
function BoardTabs({
  tab,
  onTab,
}: {
  tab: 'workload' | 'sweep'
  onTab: (t: 'workload' | 'sweep') => void
}) {
  const tabs = [
    { id: 'workload' as const, label: 'By workload' },
    { id: 'sweep' as const, label: 'By sweep' },
  ]
  return (
    <div className="subtabs boardtabs" role="tablist" aria-label="Leaderboard view">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`subtab${tab === t.id ? ' active' : ''}`}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** A sweep's date for the list: a short, unambiguous day. The time component is in the id, but
 *  the list only needs the day to tell runs apart and order them. */
function formatSweepDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The By-sweep tab's picker: one card per sweep, newest first, in the same gallery the
 * workload tab uses so the two read identically and only the card differs. Each card shows the
 * sweep's name (or a derived summary when unnamed), the workload it targeted, its run count,
 * date, and the sweep_id. The selected card is marked current, like the workload picker's; a
 * run without a sweep_id never appears here (it stays under By workload).
 */
export function SweepList({
  entries,
  selected,
  onSelect,
}: {
  entries: SweepEntry[]
  /** The sweep_id of the currently shown sweep, marked current. null when there are none. */
  selected: string | null
  onSelect: (sweepId: string) => void
}) {
  if (entries.length === 0) {
    return (
      <p className="dek">
        No sweeps yet. Declare one in <a href="#/declare">Sweep mode</a> and it appears here as a
        single entity you can return to, share by id, and view on its own.
      </p>
    )
  }
  const selectedIndex = entries.findIndex((e) => e.sweepId === selected)
  // The same gallery the workload picker uses, so the two tabs read identically; only the card
  // differs. The card mirrors the workload card's chrome — a title, a tag row, a muted count
  // line — carrying the sweep's workload, run count, date and id instead of the ranked counts.
  return (
    <CardGallery
      items={entries}
      getKey={(e) => e.sweepId}
      ariaLabel="Sweeps"
      activeIndex={selectedIndex}
      renderCard={(e) => {
        const isCurrent = e.sweepId === selected
        return (
          <button
            type="button"
            className={isCurrent ? 'wpick-card cur' : 'wpick-card'}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelect(e.sweepId)}
          >
            <span className="wtitle">{e.title}</span>
            <span className="wtags">
              <span className="spec-tag tag-workload-spec">{e.workload}</span>
            </span>
            <span className="gcount">
              <span className="ranked">
                {e.runCount} {e.runCount === 1 ? 'run' : 'runs'}
              </span>
              {e.date && <span>{formatSweepDate(e.date)}</span>}
              <span className="swid mono">{e.sweepId}</span>
            </span>
          </button>
        )
      }}
    />
  )
}

/**
 * One sweep's section, scoped: the records whose sweep_id matches, run back through the
 * existing pipeline (loadWorkloads over the subset) and rendered with the ordinary
 * WorkloadSection and its Load/Model/Hardware/SLO filter cards — which now operate within the
 * sweep. It is exactly the section the By-workload tab shows below its gallery, so the two tabs
 * read identically; the sweep gallery above is the picker. A sweep is one workload by
 * construction, so this is one section; the map is defensive.
 */
export function SweepScope({
  records,
  entry,
  revealTarget,
  onRevealed,
  canDelete,
  onDelete,
}: {
  records: RunRecord[]
  entry: SweepEntry | null
  revealTarget: RevealTarget | null
  onRevealed: () => void
  canDelete: boolean
  onDelete: (record: RunRecord) => void
}) {
  const sweepId = entry?.sweepId ?? null
  const scoped = useMemo(
    () => (sweepId ? loadWorkloads(records.filter((r) => r.sweep_id === sweepId)) : []),
    [records, sweepId],
  )
  if (scoped.length === 0) {
    return (
      <p className="dek">This sweep has no runs on the board. Its runs may have been deleted.</p>
    )
  }
  return (
    <>
      {scoped.map((w) => (
        <WorkloadSection
          key={`${sweepId}:${w.workloadKey}`}
          workload={w}
          revealTarget={revealTarget}
          onRevealed={onRevealed}
          canDelete={canDelete}
          onDelete={onDelete}
        />
      ))}
    </>
  )
}
