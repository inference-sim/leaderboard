import { useMemo } from 'react'
import { initialForm, interpret, type FormValues, type ValidateResponse } from '../workloads'
import { appendClient, parseSpec, serializeSpec, type SpecObject } from '../spec'
import { WorkloadSpecForm } from './WorkloadSpecForm'

interface Props {
  values: FormValues
  onChange: (values: FormValues) => void
  onSave: () => void
  onCancel: () => void
  /** The server's live verdict, or null before the first validate returns. */
  verdict: ValidateResponse | null
  saving: boolean
  saveError: string | null
  /** The name being edited, so a content twin that is this profile itself does not
   * block saving. Absent when authoring a new workload. */
  originalName?: string | null
}

/**
 * The workload editor. The workload is a blis WorkloadSpec, authored two ways at once:
 * a form of the common single-client fields on the left, the raw WorkloadSpec YAML on
 * the right. They edit one buffer — a form change reserializes the YAML, a YAML change
 * reparses the form — so the two never disagree. The YAML pane is the whole surface;
 * anything the form does not cover is edited there and round-trips untouched.
 *
 * name/seed/horizon/timeout are the profile's group-side knobs, not part of the spec.
 * Client-side checks mirror internal/catalog.Validate; the server's verdict adds blis's
 * own errors (it runs blis on the spec) and the content-twin check.
 */
export function WorkloadEditor({
  values,
  onChange,
  onSave,
  onCancel,
  verdict,
  saving,
  saveError,
  originalName,
}: Props) {
  const { issues, body } = interpret(values)
  const { obj, error } = useMemo(() => parseSpec(values.specYaml), [values.specYaml])
  const twinBlocks = verdict?.twin != null && verdict.twin !== originalName
  const saveDisabled = body === null || saving || twinBlocks

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    onChange({ ...values, [key]: value })
  const num = (v: string) => (v === '' ? 0 : Number(v))
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message

  // A form edit reserializes the object into the shared YAML buffer; a YAML edit sets
  // the buffer directly. Both land in values.specYaml, keeping the panes in lockstep.
  const onSpecChange = (next: SpecObject) => set('specYaml', serializeSpec(next))

  return (
    <section className="editor">
      <div className="editor-head">
        <h2>{originalName ? `Edit ${originalName}` : 'New workload'}</h2>
      </div>

      <div className="name-row">
        <div className="field editor-name">
          <label htmlFor="wl-name">Name</label>
          <input
            id="wl-name"
            name="name"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
          />
          {issueFor('name') && <p className="issue">{issueFor('name')}</p>}
        </div>
        {/* A blank label lines the button up with the Name input. Reset all returns every
            field to a fresh runnable default — the same starting point a New workload opens on. */}
        <div className="field clear-field">
          <label aria-hidden="true" className="spacer-label">
            &nbsp;
          </label>
          <button type="button" className="clear-all" onClick={() => onChange(initialForm())}>
            Reset all
          </button>
        </div>
      </div>

      <fieldset className="knobs">
        <legend>Run settings</legend>
        <p className="dek">
          Group-side knobs the leaderboard applies when it launches the run and not part of the WorkloadSpec
below. Runs are grouped and ranked by these, so they live beside the spec, not inside it.
        </p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="wl-seed">Seed</label>
            <input
              id="wl-seed"
              name="seed"
              type="number"
              value={values.seed}
              onChange={(e) => set('seed', num(e.target.value))}
            />
            {issueFor('seed') && <p className="issue">{issueFor('seed')}</p>}
          </div>
          <div className="field">
            <label htmlFor="wl-horizon">Horizon ticks (blank = unbounded)</label>
            <input
              id="wl-horizon"
              name="horizon_ticks"
              type="number"
              value={values.horizonTicks ?? ''}
              onChange={(e) => set('horizonTicks', e.target.value === '' ? null : num(e.target.value))}
            />
            {issueFor('horizonTicks') && <p className="issue">{issueFor('horizonTicks')}</p>}
          </div>
          <div className="field">
            <label htmlFor="wl-timeout">Request timeout (s)</label>
            <input
              id="wl-timeout"
              name="request_timeout_s"
              type="number"
              value={values.requestTimeoutS}
              onChange={(e) => set('requestTimeoutS', num(e.target.value))}
            />
            {issueFor('requestTimeoutS') && <p className="issue">{issueFor('requestTimeoutS')}</p>}
          </div>
        </div>
      </fieldset>

      <div className="spec-panes">
        <WorkloadSpecForm obj={obj} error={error} onChange={onSpecChange} />
        <fieldset className="spec-yaml">
          <legend>WorkloadSpec YAML</legend>
          <p className="dek">
            A blis WorkloadSpec (v2), model-free. Edit here or in the form as the two stay in sync. blis
            validates it; a model or adapter pinned in a client is rejected, since the model is chosen at
            run time.
          </p>
          <textarea
            id="wl-spec"
            name="spec_yaml"
            className="mono"
            aria-label="WorkloadSpec YAML"
            spellCheck={false}
            value={values.specYaml}
            onChange={(e) => set('specYaml', e.target.value)}
          />
          {issueFor('specYaml') && <p className="issue">{issueFor('specYaml')}</p>}
        </fieldset>
      </div>

      {/* Add client sits below the panes, not inside the form column, so the YAML pane
          matches the height of the form cards rather than stretching past them. */}
      {obj && (
        <button type="button" className="add-client" onClick={() => onSpecChange(appendClient(obj))}>
          + Add client
        </button>
      )}

      {verdict && (
        <div className="verdict">
          <p>
            <strong>{verdict.summary}</strong>
          </p>
          {verdict.twin && !twinBlocks && (
            <p className="note">
              Identical content to <code>{verdict.twin}</code> — this is that same workload.
            </p>
          )}
          {twinBlocks && (
            <p className="issue">
              This has identical content to <code>{verdict.twin}</code>. A workload has one name. Reuse it, or change a field.
            </p>
          )}
          {verdict.issues.map((msg, i) => (
            <p className="issue" key={i}>
              {msg}
            </p>
          ))}
        </div>
      )}

      {saveError && <p className="issue">{saveError}</p>}

      <div className="editor-actions">
        <button type="button" className="primary" onClick={onSave} disabled={saveDisabled}>
          {saving ? 'Saving…' : originalName ? 'Save changes' : 'Create workload'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
