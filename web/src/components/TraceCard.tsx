import { useRef, useState } from 'react'
import {
  ingestTrace as defaultIngest,
  TRACE_SESSION_MODES,
  validateTraceForm,
  type TraceForm,
} from '../workloads'
import { Select } from './Select'

interface Props {
  trace: TraceForm | null
  onChange: (t: TraceForm | null) => void
  /** Injectable so a test can drive ingest without a server. */
  ingest?: typeof defaultIngest
}

type SourceFormat = 'tracev2' | 'otel' | 'weka'

/** The session modes valid for a corpus's session_context_growth. An accumulate corpus
 * stores per-round inputs as deltas that only reconstruct in closed-loop or
 * fixed-accumulate; a non-accumulate corpus reads them as absolute, so plain fixed is
 * right and fixed-accumulate would be inert. */
function modesFor(growth: string): string[] {
  return growth === 'accumulate'
    ? ['closed-loop', 'fixed-accumulate']
    : TRACE_SESSION_MODES.filter((m) => m !== 'fixed-accumulate')
}

/**
 * The trace card: upload a trace (a native TraceV2 pair, or a raw OTel/Weka file the
 * server converts), then choose how blis replays it. Ingest happens up front — POST
 * /api/traces stores the bytes by content hash and returns the corpus — so the replay
 * knobs below act on a known trace, and the saved workload carries only the hash.
 */
export function TraceCard({ trace, onChange, ingest = defaultIngest }: Props) {
  const [sourceFormat, setSourceFormat] = useState<SourceFormat>('tracev2')
  const [contextGrowth, setContextGrowth] = useState('accumulate')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The chosen filenames, tracked so the picker can name the selected file (the native
  // control's own label is unstyleable). The files themselves are read from the refs at
  // ingest.
  const [names, setNames] = useState<{ header?: string; data?: string; input?: string }>({})
  const headerRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof TraceForm>(key: K, value: TraceForm[K]) => {
    if (trace) onChange({ ...trace, [key]: value })
  }

  async function runIngest() {
    setError(null)
    setBusy(true)
    try {
      const res = await ingest(
        sourceFormat === 'tracev2'
          ? { sourceFormat, header: headerRef.current?.files?.[0], data: dataRef.current?.files?.[0] }
          : { sourceFormat, input: inputRef.current?.files?.[0], contextGrowth },
      )
      // Seed the replay knobs from the corpus: an accumulate corpus cannot be replayed
      // fixed, so default it to closed-loop; everything else defaults to fixed.
      const sessionMode = res.session_context_growth === 'accumulate' ? 'closed-loop' : 'fixed'
      onChange({
        sessionMode,
        concurrentSessions: 0,
        totalSessions: 0,
        shuffleCorpus: false,
        thinkTimeMs: 0,
        thinkTimeDist: '',
        sha256: res.sha256,
        sourceFormat: res.source_format,
        records: res.records,
        sessions: res.sessions,
        sessionContextGrowth: res.session_context_growth,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const ingested = trace != null && trace.sha256 !== ''

  return (
    <fieldset className="trace-card">
      <legend>Trace</legend>
      <p className="dek">
        Replay a recorded request stream through blis. Bring a native TraceV2 pair (header YAML +
        data CSV), or a raw OpenTelemetry or Weka file the server converts. The trace is stored by
        content hash; this workload references it, so the same trace is one table however it is
        replayed.
      </p>

      {!ingested && (
        <div className="trace-ingest">
          <div className="field">
            <label htmlFor="tc-format">Source format</label>
            <Select
              id="tc-format"
              value={sourceFormat}
              onChange={(v) => setSourceFormat(v as SourceFormat)}
              options={[
                { value: 'tracev2', label: 'TraceV2', hint: 'header + data' },
                { value: 'otel', label: 'OpenTelemetry', hint: 'JSON' },
                { value: 'weka', label: 'Weka', hint: 'JSONL' },
              ]}
              ariaLabel="Source format"
            />
          </div>

          {sourceFormat === 'tracev2' ? (
            <div className="field-row">
              <FilePick
                id="tc-header"
                label="Header"
                accept=".yaml,.yml"
                name={names.header}
                inputRef={headerRef}
                onPick={(n) => setNames((s) => ({ ...s, header: n }))}
              />
              <FilePick
                id="tc-data"
                label="Data"
                accept=".csv"
                name={names.data}
                inputRef={dataRef}
                onPick={(n) => setNames((s) => ({ ...s, data: n }))}
              />
            </div>
          ) : (
            <div className="field-row">
              <FilePick
                id="tc-input"
                label={sourceFormat === 'otel' ? 'OTel trace' : 'Weka sessions'}
                accept=".json,.jsonl"
                name={names.input}
                inputRef={inputRef}
                onPick={(n) => setNames((s) => ({ ...s, input: n }))}
              />
              <div className="field">
                <label htmlFor="tc-growth">Context growth</label>
                <Select
                  id="tc-growth"
                  value={contextGrowth}
                  onChange={setContextGrowth}
                  options={[
                    { value: 'accumulate', label: 'accumulate', hint: 'growing shared prefix' },
                    { value: 'independent', label: 'independent' },
                  ]}
                  ariaLabel="Context growth"
                />
              </div>
            </div>
          )}

          <button type="button" className="primary" onClick={runIngest} disabled={busy}>
            {busy ? 'Ingesting…' : 'Ingest trace'}
          </button>
          {error && <p className="issue">{error}</p>}
        </div>
      )}

      {ingested && trace && (
        <div className="trace-replay">
          <p className="trace-corpus">
            <strong>{trace.sourceFormat}</strong> trace ·{' '}
            {trace.records.toLocaleString('en-US')} records ·{' '}
            {trace.sessions.toLocaleString('en-US')} sessions
            {trace.sessionContextGrowth ? ` · ${trace.sessionContextGrowth}` : ''}
            <button type="button" className="link-button" onClick={() => onChange(null)}>
              Replace trace
            </button>
          </p>

          <div className="field-row">
            <div className="field">
              <label htmlFor="tc-mode">Session mode</label>
              <Select
                id="tc-mode"
                value={trace.sessionMode}
                onChange={(v) => set('sessionMode', v)}
                options={modesFor(trace.sessionContextGrowth).map((m) => ({ value: m, label: m }))}
                ariaLabel="Session mode"
              />
            </div>
            <div className="field">
              <label htmlFor="tc-pool">Concurrent sessions (0 = recorded arrivals)</label>
              <input
                id="tc-pool"
                type="number"
                min={0}
                value={trace.concurrentSessions}
                onChange={(e) => set('concurrentSessions', e.target.value === '' ? 0 : Number(e.target.value))}
              />
            </div>
          </div>

          {trace.concurrentSessions > 0 && (
            <div className="field-row">
              <div className="field">
                <label htmlFor="tc-total">Total sessions (0 = corpus once)</label>
                <input
                  id="tc-total"
                  type="number"
                  min={0}
                  value={trace.totalSessions}
                  onChange={(e) => set('totalSessions', e.target.value === '' ? 0 : Number(e.target.value))}
                />
              </div>
              <div className="field checkbox-field">
                <label htmlFor="tc-shuffle">
                  <input
                    id="tc-shuffle"
                    type="checkbox"
                    checked={trace.shuffleCorpus}
                    onChange={(e) => set('shuffleCorpus', e.target.checked)}
                  />
                  Shuffle corpus
                </label>
              </div>
            </div>
          )}

          {trace.sessionMode === 'closed-loop' && (
            <div className="field-row">
              <div className="field">
                <label htmlFor="tc-think-ms">Think time (ms, 0 = from trace)</label>
                <input
                  id="tc-think-ms"
                  type="number"
                  min={0}
                  value={trace.thinkTimeMs}
                  onChange={(e) => set('thinkTimeMs', e.target.value === '' ? 0 : Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="tc-think-dist">Think-time distribution (optional)</label>
                <input
                  id="tc-think-dist"
                  type="text"
                  placeholder="lognormal:mu=2,sigma=0.6,min=3s,max=30s"
                  value={trace.thinkTimeDist}
                  onChange={(e) => set('thinkTimeDist', e.target.value)}
                />
              </div>
            </div>
          )}

          {validateTraceForm(trace).map((msg, i) => (
            <p className="issue" key={i}>
              {msg}
            </p>
          ))}
        </div>
      )}
    </fieldset>
  )
}

/**
 * A file picker in the page's own vocabulary: the native control is unstyleable, so the
 * real input is visually hidden and a label styled as a button drives it, with the chosen
 * filename shown beside it. Focus and keyboard both reach the input through the label.
 */
function FilePick({
  id,
  label,
  accept,
  name,
  inputRef,
  onPick,
}: {
  id: string
  label: string
  accept: string
  name: string | undefined
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: (name: string | undefined) => void
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="filepick">
        {/* Input first, hidden but focusable, so its focus ring can be mirrored onto the
            button via an adjacent-sibling selector. */}
        <input
          id={id}
          ref={inputRef}
          type="file"
          accept={accept}
          className="filepick-input"
          onChange={(e) => onPick(e.target.files?.[0]?.name)}
        />
        <label className="filepick-btn" htmlFor={id}>
          Choose file
        </label>
        <span className={name ? 'filepick-name' : 'filepick-name filepick-none'}>
          {name ?? 'No file chosen'}
        </span>
      </div>
    </div>
  )
}
