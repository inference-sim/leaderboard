import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkloadGroup } from '../load'
import {
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
import { workloadParam } from '../route'
import { ConfirmDialog } from './ConfirmDialog'
import { WorkloadCatalog } from './WorkloadCatalog'
import { WorkloadEditor } from './WorkloadEditor'

interface Props {
  /** The board's workloads, so the catalog can cross-reference existing runs. */
  boardWorkloads: WorkloadGroup[]
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

export function Workloads({ boardWorkloads }: Props) {
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
      await refresh()
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
    try {
      await deleteWorkload(name)
      if (selected === name) setSelected(null)
      await refresh()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <p className="dek tab-intro">
        A workload profile is a reusable definition of the work offered to a run, without the model.
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
        Delete <code className="mono">{pendingDelete}</code>? This removes it from the catalog only.
        Runs already on the board keep their own copy.
      </ConfirmDialog>
    </>
  )
}
