import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkloadGroup } from '../load'
import {
  associatedRecords,
  deleteWorkload,
  initialForm,
  interpret,
  listWorkloads,
  saveWorkload,
  validateWorkload,
  type FormValues,
  type ProfileBody,
  type ValidateResponse,
} from '../workloads'
import { deleteRun } from '../results'
import { workloadParam } from '../route'
import { ConfirmDialog } from './ConfirmDialog'
import { WorkloadCatalog } from './WorkloadCatalog'
import { WorkloadEditor } from './WorkloadEditor'

interface Props {
  /** The board's workloads, so the catalog can cross-reference existing runs. */
  boardWorkloads: WorkloadGroup[]
  /** A just-saved workload to scroll to and highlight (set by the "View in catalog" toast
   * after a run saved a new custom workload), or null. */
  revealWorkload?: string | null
  /** Called once the highlight has shown, so the parent clears the target and it does not
   * re-fire on a later refresh. */
  onWorkloadRevealed?: () => void
  /** Called with the name when the tab's own editor saves a workload to the catalog, so the
   * app can show the same "added to the catalog" confirmation it shows for a run's save. */
  onWorkloadSaved?: (name: string) => void
  /** Called after a delete has removed runs from disk, so the app can reload the board's
   * records and the deleted workload's rows leave the leaderboard. */
  onBoardChanged?: () => void | Promise<void>
}

interface Editing {
  values: FormValues
}

/**
 * The Workloads tab: a catalog browser and an editor, backed by the /api/workloads
 * endpoints. Like the Leaderboard's live results, the catalog is read from the running
 * server; without one, the tab shows why it is empty rather than a blank page. The
 * editor validates live against the server (which runs blis for a raw spec), so what
 * Save writes is what was already shown to be runnable. The editor only authors new
 * workloads; a saved one is deleted, not edited in place.
 */
/** A fresh new-workload editing state, opened with BLIS's own defaults. */
const freshNew = (): Editing => ({ values: initialForm() })

/** How long a revealed workload row stays highlighted, matched to the pulse keyframe. */
const REVEAL_MS = 2000

export function Workloads({
  boardWorkloads,
  revealWorkload = null,
  onWorkloadRevealed,
  onWorkloadSaved,
  onBoardChanged,
}: Props) {
  const [profiles, setProfiles] = useState<ProfileBody[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  // The editor is always open on a fresh new workload, so no button gates it; Cancel or a
  // successful Save resets it to a new one.
  const [editing, setEditing] = useState<Editing>(freshNew)
  const [verdict, setVerdict] = useState<ValidateResponse | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The card whose full spec is shown below the gallery. Held here (not in the catalog)
  // so it survives a refresh; clicking the open card again closes the panel. It opens on
  // the workload named by #/workloads?workload=<name> — the "edit it in the Workloads tab"
  // hand-off from the Declare form — so the reader lands on the card they came to see.
  const [selected, setSelected] = useState<string | null>(() =>
    workloadParam(window.location.hash),
  )
  const toggleSelected = (name: string) => setSelected((cur) => (cur === name ? null : name))
  // The deep-linked workload waiting to be scrolled into view, or null once done (or when
  // arrived without a deep link). Cleared after the one scroll so a later refresh or a
  // manual selection never yanks the page.
  const deepLink = useRef<string | null>(workloadParam(window.location.hash))
  // The workload the delete confirmation is open for, or null when the dialog is closed.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  // The reveal pipeline. `revealName` is the workload a scroll+pulse has been requested for
  // (from the toast's "View in catalog" via the prop, or from this tab's own Save); `revealed`
  // is the row currently pulsing. They are separate from `selected` so the pulse runs on its
  // own ~2s clock while the row stays selected (open) afterwards. A reveal first selects the
  // row, so it carries the fixed wrow-selected id the scroll targets.
  const [revealName, setRevealName] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      setProfiles(await listWorkloads())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Once the deep-linked workload's row has loaded, bring it into view. The catalog marks
  // the selected row with a fixed id, so this finds it whatever the workload is named.
  useEffect(() => {
    const name = deepLink.current
    if (!name || !profiles.some((p) => p.name === name)) return
    deepLink.current = null
    document.getElementById('wrow-selected')?.scrollIntoView({ block: 'center' })
  }, [profiles])

  // A reveal request from the toast's "View in catalog": select the target row and request
  // the reveal, then refresh, since the workload was saved moments ago and may not be in this
  // tab's list yet. (An in-tab Save drives the same two states directly, below.)
  useEffect(() => {
    if (!revealWorkload) return
    setSelected(revealWorkload)
    setRevealName(revealWorkload)
    refresh()
  }, [revealWorkload, refresh])

  // Perform the reveal once its row is both selected (so it carries the wrow-selected id) and
  // present in the loaded list: scroll it into view and pulse it for ~2s, then clear and tell
  // the parent (a no-op for an in-tab Save, which passes no onWorkloadRevealed). Requiring
  // selected === revealName means the id is already in the DOM when we scroll.
  useEffect(() => {
    if (!revealName || selected !== revealName) return
    if (!profiles.some((p) => p.name === revealName)) return
    document.getElementById('wrow-selected')?.scrollIntoView({ block: 'center' })
    setRevealed(revealName)
    setRevealName(null)
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => {
      setRevealed(null)
      onWorkloadRevealed?.()
    }, REVEAL_MS)
  }, [revealName, selected, profiles, onWorkloadRevealed])

  // Drop the pending pulse timer if the tab unmounts mid-highlight.
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current) }, [])

  // Live validation, debounced: only the last edit in a burst reaches the server, and a
  // stale response never overwrites a newer one.
  const validateSeq = useRef(0)
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleValidate = useCallback((values: FormValues) => {
    if (validateTimer.current) clearTimeout(validateTimer.current)
    const body = interpret(values).body
    if (!body) {
      setVerdict(null)
      return
    }
    validateTimer.current = setTimeout(async () => {
      const seq = ++validateSeq.current
      try {
        const v = await validateWorkload(body)
        if (seq === validateSeq.current) setVerdict(v)
      } catch {
        // A validate call that cannot reach the server leaves the client-side checks in
        // charge; Save still surfaces a server error if it is down.
        if (seq === validateSeq.current) setVerdict(null)
      }
    }, 300)
  }, [])

  const onChange = (values: FormValues) => {
    setEditing((cur) => ({ ...cur, values }))
    scheduleValidate(values)
  }

  const onCancel = () => {
    setEditing(freshNew())
    setSaveError(null)
    setVerdict(null)
  }

  const onSave = async () => {
    const body = interpret(editing.values).body
    if (!body) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveWorkload(body, null)
      setEditing(freshNew())
      setVerdict(null)
      // The list now holds the new workload; select it and request the reveal so the row it
      // just dropped into the catalog scrolls into view and pulses, and confirm the save with
      // the same toast a run's save shows (the reader is already here, so it needs no "View in
      // catalog" action — the app passes none).
      await refresh()
      setSelected(body.name)
      setRevealName(body.name)
      onWorkloadSaved?.(body.name)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Deletion is irreversible, so it is gated by a confirmation modal: the catalog's Delete
  // opens the dialog, and only its confirm actually removes the workload.
  const onDelete = (name: string) => setPendingDelete(name)

  const confirmDelete = async () => {
    const name = pendingDelete
    if (name == null) return
    setPendingDelete(null)
    const profile = profiles.find((p) => p.name === name)
    // Every leaderboard run filed under this workload, deleted along with it so none is left
    // stranded under a profile that no longer exists. Runs go first (then the profile), so a
    // failure part-way leaves the profile in place and the delete is retryable rather than
    // orphaning it. A client loop is not atomic; whatever did delete is reflected by the
    // refresh below either way.
    const runs = profile ? associatedRecords(profile, boardWorkloads) : []
    try {
      for (const r of runs) await deleteRun(r.group_id, r.run_id)
      await deleteWorkload(name)
      if (selected === name) setSelected(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      // Refresh the catalog and, when runs were removed, the board, so the leaderboard drops
      // the deleted rows without a manual reload.
      await refresh()
      if (runs.length > 0) await onBoardChanged?.()
    }
  }

  // The runs a delete of the pending workload would also remove, for the modal's warning. It
  // matches associatedRecords exactly, so the count shown is the count deleted.
  const pendingProfile = pendingDelete ? profiles.find((p) => p.name === pendingDelete) : null
  const pendingRuns = pendingProfile ? associatedRecords(pendingProfile, boardWorkloads).length : 0

  return (
    <>
      <p className="dek tab-intro">
        A workload profile is a reusable definition of the work offered to a run, without the model
        or the offered load. Model and load are chosen per run, and varying the load runs one
        profile across rates or concurrency to compare how it scales.
      </p>
      <WorkloadEditor
        values={editing.values}
        onChange={onChange}
        onSave={onSave}
        onCancel={onCancel}
        verdict={verdict}
        saving={saving}
        saveError={saveError}
      />
      {/* The catalog rides below the editor: browse and delete saved workloads, or author a
          new one above. A saved workload is not edited in place, so the two never contend. */}
      {loadError && (
        <p className="dek issue">
          {loadError} The catalog needs the run server: <code>make build &amp;&amp; ./bin/leaderboard serve</code>.
        </p>
      )}
      <WorkloadCatalog
        profiles={profiles}
        boardWorkloads={boardWorkloads}
        selected={selected}
        revealed={revealed}
        onSelect={toggleSelected}
        onDelete={onDelete}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete workload?"
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingRuns > 0 ? (
          <>
            Delete <code className="mono">{pendingDelete}</code>? This also permanently deletes its{' '}
            {pendingRuns} run{pendingRuns === 1 ? '' : 's'} from the leaderboard and removes their
            results from disk. This cannot be undone; re-run the declaration to bring them back.
          </>
        ) : (
          <>
            Delete <code className="mono">{pendingDelete}</code>? This removes it from the catalog. It
            has no runs on the leaderboard.
          </>
        )}
      </ConfirmDialog>
    </>
  )
}
