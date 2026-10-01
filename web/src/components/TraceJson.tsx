import { useEffect, useState } from 'react'
import { fetchTraceRecords, type TraceRecords } from '../workloads'
import { CopyBlock } from './CopyBlock'

/**
 * The "view trace as JSON" panel: a collapsed <details> that, when first opened, fetches the
 * trace's header and a sample of its records and shows them as JSON. It is lazy on purpose — a
 * trace card may be opened only to read the charts, so the fetch (and the run server it needs)
 * waits until the reader asks for the raw records. A corpus is tens of thousands of records, so
 * only a sample is fetched and the panel says "first N of M".
 */
export function TraceJson({ sha256 }: { sha256: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: TraceRecords }
  >({ status: 'idle' })

  useEffect(() => {
    if (!open || state.status !== 'idle') return
    setState({ status: 'loading' })
    fetchTraceRecords(sha256, 50)
      .then((data) => setState({ status: 'ready', data }))
      .catch((e) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }))
  }, [open, state.status, sha256])

  return (
    <details className="spec-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>View trace as JSON</summary>
      {state.status === 'loading' && <p className="dek">Reading the trace.</p>}
      {state.status === 'error' && (
        <p className="dek issue">
          {state.message} The records need the run server:{' '}
          <code>make build &amp;&amp; ./bin/leaderboard serve</code>.
        </p>
      )}
      {state.status === 'ready' && (
        <CopyBlock
          label="trace.json"
          hint={`The trace header and the first ${state.data.records.length} of ${state.data.total_records.toLocaleString('en-US')} records. The bytes live server-side; this is a sample.`}
          text={JSON.stringify(state.data, null, 2)}
        />
      )}
    </details>
  )
}
