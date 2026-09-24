import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { RunGroup } from '../load'
import {
  ADMISSION_POLICIES,
  DEFAULT_ROUTING_SCORERS,
  KV_CACHE_DTYPES,
  LATENCY_MODELS,
  MOE_COMM_BACKENDS,
  PD_DECIDERS,
  PREEMPTION_POLICIES,
  ROUTING_POLICIES,
  ROUTING_SCORERS,
  SCHEDULERS,
  SELECTABLE_HARDWARE,
  SPECULATIVE_METHODS,
  TP_CHOICES,
} from '../catalog'
import { customFieldsFrom, interpret, suggestRunId, suggestWorkloadName } from '../newrun'
import type { FormValues, Output } from '../newrun'
import { isMoE, listModels } from '../models'
import type { ModelInfo } from '../models'
import { workloadParam, workloadsHref } from '../route'
import { listWorkloads, profileKnobs, profileSummary } from '../workloads'
import type { ProfileBody } from '../workloads'
import { shellLines } from '../repro'
import { CopyBlock } from './CopyBlock'
import { Select } from './Select'
import type { SelectOption } from './Select'

interface Props {
  groups: RunGroup[]
  /** The form's field values. Lifted to App (§4) so they survive the navigation to the
   * board when Run is clicked, and so a bounce back after a failed run finds the form
   * exactly as it was left. */
  values: FormValues
  /** Updates the lifted form values. Passed straight to the field setters. */
  onChange: Dispatch<SetStateAction<FormValues>>
  /** Whether NewRun has already applied its one-time catalog default to `workloadSel`.
   * Lifted alongside the values, so a remount after a failed run does not re-run that
   * default and clobber the workload the reader had chosen. */
  workloadInitialized: boolean
  /** Marks the catalog default as applied. */
  onWorkloadInitialized: () => void
  /** Whether the reader has typed their own run id. Lifted alongside the values, so the
   * descriptive auto-id stops syncing the moment they take it over — and a remount after a
   * failed run does not resume syncing and clobber the id they had chosen. */
  runIdEdited: boolean
  /** Marks the run id as reader-owned, freezing the auto-sync. */
  onRunIdEdited: () => void
  /** Whether the reader has typed their own custom workload name. Lifted alongside the
   * values, like runIdEdited, so the suggested `custom-N` keeps syncing against the catalog
   * until they take it over, and a remount after a failed run does not resume syncing and
   * clobber the name they had chosen. */
  customNameEdited: boolean
  /** Marks the custom name as reader-owned, freezing its auto-sync. */
  onCustomNameEdited: () => void
  /** True while a run is in flight. Disables the Run button (a second concurrent run is
   * already impossible, since the click moves the reader to the board). */
  running: boolean
  /** The last failed run's message (blis's own text, or the "start the server" note), or
   * null. Rendered as the "Did not run" block; the board never shows a stranded error. */
  errorMessage: string | null
  /** Hands a validated declaration up to App, which drives the run and the navigation. */
  onRun: (output: Output) => void
}

/**
 * Declares one run and runs it. The form selects the work (a catalog workload, preset or
 * saved, or a simple inline custom workload) plus a model and a candidate; the Run button
 * sends them to `leaderboard serve`, which executes blis from the upstream checkout (blis
 * resolves defaults.yaml and hardware_config.json relative to that directory, and the
 * model catalog via BLIS_CATALOG, so a browser cannot run it) and writes the same
 * results/<group_id>/<run_id>.json the CLI does. The result appears in place and on the
 * leaderboard, without a rebuild.
 *
 * The form is split the way the schema is split, because that split is the whole
 * comparability guarantee: the top box is the work offered, which every row of a table
 * shares and which decides the table; the bottom box is the candidate under test. The
 * panel beside them answers the question that follows from it, which table does this land
 * in, before anything is run.
 */
export function NewRun({
  groups,
  values,
  onChange: setValues,
  workloadInitialized,
  onWorkloadInitialized,
  runIdEdited,
  onRunIdEdited,
  customNameEdited,
  onCustomNameEdited,
  running,
  errorMessage,
  onRun,
}: Props) {
  const [profiles, setProfiles] = useState<ProfileBody[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // The catalog is the single source of named workloads (R1). It is fetched with the same
  // call the Workloads tab uses; when it cannot be loaded (no server, a fetch error) the
  // page degrades to the custom card, exactly today's offline authoring capability (R8).
  // The one-time default selection is guarded by workloadInitialized, which lives in App:
  // a remount after a failed run therefore does not re-run it and overwrite the reader's
  // chosen workload.
  useEffect(() => {
    let cancelled = false
    listWorkloads().then(
      (ps) => {
        if (cancelled) return
        setProfiles(ps)
        if (workloadInitialized) return
        onWorkloadInitialized()
        // #/declare?workload=<name> preselects that workload (the deferred "Declare a run
        // with this" hand-off, spec §8); absent or unknown falls back to R2's default, the
        // first catalog entry.
        const want = workloadParam(window.location.hash)
        const initSel = want && ps.some((p) => p.name === want) ? want : ps[0]?.name ?? ''
        if (initSel !== '') setValues((v) => ({ ...v, workloadSel: initSel }))
      },
      (e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // The model catalog is fetched the same way as the workload catalog: served live from
  // the blis-catalog clone (GET /api/models) rather than frozen into the front-end. There
  // is no committed fallback — when it cannot be loaded the picker is empty and the same
  // load error is shown, and interpret() skips the model check until the list arrives.
  useEffect(() => {
    let cancelled = false
    listModels().then(
      (ms) => {
        if (!cancelled) setModels(ms)
      },
      (e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the run id in step with the candidate it names, until the reader takes it over.
  // suggestRunId derives <hardware>-tp<tp> and dedupes it against the table this candidate
  // would join, so the page is runnable without typing a filename and the id never
  // silently overwrites an existing row. It ignores values.runId, so setting the id here
  // does not feed back into a new suggestion: the effect converges. Once the reader edits
  // the field (runIdEdited), their id stands, including across a failed-run remount, since
  // runIdEdited lives in App with the values.
  useEffect(() => {
    if (runIdEdited) return
    const suggested = suggestRunId(values, groups, profiles)
    setValues((v) => (v.runId === suggested ? v : { ...v, runId: suggested }))
  }, [values, groups, profiles, runIdEdited, setValues])

  // Keep the custom workload's name in step the same way, but only while the custom card is
  // the chosen work (workloadSel === ''): a saved workload names itself, so its selection is
  // left alone. suggestWorkloadName gives the lowest free custom-N against the catalog, so
  // the card opens on a valid, unique name and the next custom run gets a fresh one once the
  // last is saved. It reads only the catalog, not values.customName, so the effect converges;
  // once the reader types their own (customNameEdited) it stops, across a failed-run remount.
  useEffect(() => {
    if (customNameEdited || values.workloadSel !== '') return
    const suggested = suggestWorkloadName(profiles)
    setValues((v) => (v.customName === suggested ? v : { ...v, customName: suggested }))
  }, [values.workloadSel, profiles, customNameEdited, setValues])

  const { issues, output, notes } = useMemo(
    () => interpret(values, groups, profiles, models),
    [values, groups, profiles, models],
  )

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }))

  // Switching to Custom prefills the card from the profile that was selected (R5): a
  // distribution profile fills it with its own values, a spec profile or a fresh page with
  // the flat fallback; the card cannot represent a spec, so it never pretends to.
  const onSelectWorkload = (name: string) => {
    if (name !== '') {
      set('workloadSel', name)
      return
    }
    const prev = profiles.find((p) => p.name === values.workloadSel) ?? null
    setValues((v) => ({ ...v, workloadSel: '', ...customFieldsFrom(prev) }))
  }

  const selectedProfile =
    values.workloadSel !== '' ? profiles.find((p) => p.name === values.workloadSel) ?? null : null
  const presets = profiles.filter((p) => p.builtin)
  const saved = profiles.filter((p) => !p.builtin)
  const issueFor = (field: keyof FormValues) => issues.find((i) => i.field === field)
  const loadIsRate = values.loadKind === 'rate'
  // The expert-parallel and MoE-comm-backend knobs are always shown so the candidate box keeps
  // a stable shape; a dense model disables them rather than hiding them (blis rejects them on a
  // dense model, and switching to one already clears them to off/empty).
  const modelIsMoE = isMoE(models, values.model)

  // The two workload types the page offers: a saved or preset workload (chosen from the
  // catalog), or a custom distribution defined inline and saved to the catalog on Run. The
  // toggle picks the type; workloadSel === '' is the custom type, a name is the saved one.
  const isCustom = values.workloadSel === ''
  const hasProfiles = profiles.length > 0
  const firstProfileName = presets[0]?.name ?? saved[0]?.name ?? ''
  // Switching to the saved/preset type selects the first catalog workload; to custom clears
  // the selection and prefills the card from whatever was selected (R5). onSelectWorkload
  // already carries the prefill, so custom routes through it.
  const setWorkloadType = (type: 'saved' | 'custom') => {
    if (type === 'custom') onSelectWorkload('')
    else if (isCustom && firstProfileName !== '') set('workloadSel', firstProfileName)
  }

  // Presets first (tagged), then saved profiles — the styled dropdown for the saved type.
  const workloadOptions: SelectOption[] = [
    ...presets.map((p) => ({ value: p.name, label: p.name, hint: 'preset' })),
    ...saved.map((p) => ({ value: p.name, label: p.name })),
  ]
  const modelOptions: SelectOption[] = models.map((m) => ({ value: m.name, label: m.name }))
  if (values.model !== '' && !models.some((m) => m.name === values.model)) {
    modelOptions.push({ value: values.model, label: values.model })
  }

  // One serving knob as a number field. min is '0' for the fields where 0 is a valid
  // "off"/auto (max-model-len, long-prefill, draft tokens); step is a
  // fraction for the two ratio knobs (gpu-memory-utilization, acceptance rate).
  const knobNum = (field: keyof FormValues, label: string, min = '1', step = '1') => (
    <>
      <label className="nrrow">
        <span className="nrlabel">{label}</span>
        <input
          type="number"
          min={min}
          step={step}
          value={String(values[field])}
          onChange={(e) => set(field, e.target.value as FormValues[typeof field])}
          aria-invalid={issueFor(field) != null}
        />
      </label>
      {issueFor(field) && <p className="nrerr">{issueFor(field)!.message}</p>}
    </>
  )

  // One serving knob as a closed dropdown over the names blis accepts (catalog.ts), so
  // the form cannot declare a value the simulator would reject. `disabled` greys it out for a
  // knob that does not apply to the current model (the MoE comm backend on a dense model).
  const knobSel = (field: keyof FormValues, label: string, choices: string[], disabled = false) => {
    const labelId = `${field}-label`
    return (
      <>
        <div className="nrrow">
          <span className="nrlabel" id={labelId}>
            {label}
          </span>
          <Select
            labelledBy={labelId}
            value={String(values[field])}
            onChange={(v) => set(field, v as FormValues[typeof field])}
            options={choices.map((c) => ({ value: c, label: c === '' ? '(none)' : c }))}
            disabled={disabled}
          />
        </div>
        {issueFor(field) && <p className="nrerr">{issueFor(field)!.message}</p>}
      </>
    )
  }

  // A themed group of candidate flags. Every group folds into a <details>, so the form reads
  // as a stack of section headers a reader can open one at a time rather than a wall of knobs.
  // The boolean is only the starting state: open for the groups a run usually touches, closed
  // for the off/default-heavy ones. React writes `open` only when the value changes between
  // renders, and it never does here, so this seeds the initial fold without fighting a reader
  // who then toggles it.
  const flagGroup = (title: string, defaultOpen: boolean, children: ReactNode, note?: ReactNode) => (
    <details className="nrflaggroup" open={defaultOpen}>
      <summary>{title}</summary>
      {children}
      {note && <p className="nrnote">{note}</p>}
    </details>
  )

  return (
    <>
      <h2 className="viewhead">Declare a run</h2>
      <p className="dek">
        Choose the work and the candidate, then run it. The button sends the declaration to{' '}
        <code>leaderboard serve</code>, which executes blis from its checkout and files the
        result, which lands here and on the leaderboard straight away. blis reads its config
        files relative to that checkout, so the server runs it, not the browser.
      </p>

      <div className="nrgrid">
        <form className="nrform" onSubmit={(e) => e.preventDefault()}>
          <fieldset className="nrwork">
            <legend>Work offered</legend>

            <div className="nrrow">
              <span className="nrlabel" id="wtype-label">
                Workload type
              </span>
              <div className="seg seg-wrap" role="radiogroup" aria-labelledby="wtype-label">
                <label className={!isCustom ? 'on' : undefined}>
                  <input
                    type="radio"
                    name="workloadType"
                    checked={!isCustom}
                    disabled={!hasProfiles}
                    onChange={() => setWorkloadType('saved')}
                  />
                  Saved / preset
                </label>
                <label className={isCustom ? 'on' : undefined}>
                  <input
                    type="radio"
                    name="workloadType"
                    checked={isCustom}
                    onChange={() => setWorkloadType('custom')}
                  />
                  Custom (distribution)
                </label>
              </div>
            </div>
            {loadError && (
              <p className="nrnote">
                The workload catalog needs the server, which is not reachable, so only a custom
                workload is available. Start it with{' '}
                <code>make build &amp;&amp; ./bin/leaderboard serve</code> to choose a preset or
                saved profile.
              </p>
            )}

            {isCustom ? (
              <>
                <CustomCard
                  values={values}
                  set={set}
                  issueFor={issueFor}
                  loadIsRate={loadIsRate}
                  onNameEdited={onCustomNameEdited}
                />
                {notes.map((note) => (
                  <p key={note} className="nrnote nrwarn" role="status">
                    {note}
                  </p>
                ))}
              </>
            ) : (
              <>
                <div className="nrrow">
                  <span className="nrlabel" id="workload-label">
                    Workload
                  </span>
                  <Select
                    labelledBy="workload-label"
                    value={values.workloadSel}
                    onChange={onSelectWorkload}
                    options={workloadOptions}
                  />
                </div>
                {issueFor('workloadSel') && (
                  <p className="nrerr">{issueFor('workloadSel')!.message}</p>
                )}
                {selectedProfile && (
                  <div className="nrsummary">
                    <p className="nrsummaryline">{profileSummary(selectedProfile)}</p>
                    <p className="nrknobs">{profileKnobs(selectedProfile)}</p>
                    <p className="nrnote">
                      A named workload from the catalog. To change its shape, edit it in the{' '}
                      <a href={workloadsHref(selectedProfile.name)}>Workloads tab</a>, which opens
                      on this workload&apos;s card. A run never silently diverges from the workload
                      it names.
                    </p>
                  </div>
                )}
              </>
            )}
          </fieldset>

          <fieldset className="nrcand">
            <legend>Candidate under test</legend>

            <label className="nrrow">
              <span className="nrlabel">Run id</span>
              <input
                type="text"
                value={values.runId}
                placeholder="h100-tp8"
                spellCheck={false}
                onChange={(e) => {
                  onRunIdEdited()
                  set('runId', e.target.value)
                }}
                aria-invalid={issueFor('runId') != null}
              />
            </label>
            {issueFor('runId') && <p className="nrerr">{issueFor('runId')!.message}</p>}

            {flagGroup(
              'Model & sharding',
              true,
              <>
                <div className="nrrow">
                  <span className="nrlabel" id="model-label">
                    Model
                  </span>
                  <Select
                    labelledBy="model-label"
                    value={values.model}
                    onChange={(v) =>
                      setValues((prev) => ({
                        ...prev,
                        model: v,
                        // A dense model cannot carry the MoE knobs (blis rejects them), so
                        // switching to one clears them rather than leaving a dead selection.
                        ...(isMoE(models, v) ? {} : { enableExpertParallel: false, moeCommBackend: '' }),
                      }))
                    }
                    options={modelOptions}
                  />
                </div>
                {issueFor('model') && <p className="nrerr">{issueFor('model')!.message}</p>}

                <div className="nrrow">
                  <span className="nrlabel" id="hw-label">
                    Accelerator
                  </span>
                  <div className="seg seg-wrap" role="radiogroup" aria-labelledby="hw-label">
                    {SELECTABLE_HARDWARE.map((hw) => (
                      <label key={hw.name} className={values.hardware === hw.name ? 'on' : undefined}>
                        <input
                          type="radio"
                          name="hardware"
                          value={hw.name}
                          checked={values.hardware === hw.name}
                          onChange={() => set('hardware', hw.name)}
                        />
                        {hw.name}
                      </label>
                    ))}
                  </div>
                </div>
                {issueFor('hardware') && <p className="nrerr">{issueFor('hardware')!.message}</p>}

                <div className="nrrow">
                  <span className="nrlabel" id="tp-label">
                    Tensor parallel
                  </span>
                  <div className="seg seg-wrap" role="radiogroup" aria-labelledby="tp-label">
                    {TP_CHOICES.map((tp) => (
                      <label key={tp} className={values.tp === String(tp) ? 'on' : undefined}>
                        <input
                          type="radio"
                          name="tp"
                          value={tp}
                          checked={values.tp === String(tp)}
                          onChange={() => set('tp', String(tp))}
                        />
                        {tp}
                      </label>
                    ))}
                  </div>
                </div>
                {issueFor('tp') && <p className="nrerr">{issueFor('tp')!.message}</p>}

                {knobNum('dp', 'Data parallel')}

                <div className="nrrow">
                  <span className="nrlabel" id="ep-label">
                    Expert parallel
                  </span>
                  <div
                    className={modelIsMoE ? 'seg' : 'seg disabled'}
                    role="radiogroup"
                    aria-labelledby="ep-label"
                  >
                    {([['off', false], ['on', true]] as const).map(([label, on]) => (
                      <label key={label} className={values.enableExpertParallel === on ? 'on' : undefined}>
                        <input
                          type="radio"
                          name="enableExpertParallel"
                          checked={values.enableExpertParallel === on}
                          disabled={!modelIsMoE}
                          onChange={() => set('enableExpertParallel', on)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                {issueFor('enableExpertParallel') && (
                  <p className="nrerr">{issueFor('enableExpertParallel')!.message}</p>
                )}
                {knobSel('moeCommBackend', 'MoE comm backend', MOE_COMM_BACKENDS, !modelIsMoE)}
                {!modelIsMoE && (
                  <p className="nrnote">
                    Expert parallelism and the MoE comm backend apply to MoE models only;{' '}
                    <code>{values.model}</code> is dense, so they stay off.
                  </p>
                )}

                {knobNum('maxModelLen', 'Max model length', '0')}
              </>,
            )}

            {flagGroup(
              'Scheduling & batching',
              true,
              <>
                {knobSel('scheduler', 'Scheduler', SCHEDULERS)}
                {knobSel('preemptionPolicy', 'Preemption policy', PREEMPTION_POLICIES)}
                {knobNum('maxNumSeqs', 'Max sequences')}
                {knobNum('maxNumBatchedTokens', 'Max batched tokens')}
                {knobNum('longPrefillTokenThreshold', 'Long-prefill token threshold', '0')}
              </>,
            )}

            {flagGroup(
              'KV cache',
              true,
              <>
                {knobSel('kvCacheDtype', 'KV cache dtype', KV_CACHE_DTYPES)}
                {knobNum('blockSize', 'KV block size (tokens)')}
                {knobNum('gpuMemoryUtilization', 'GPU memory utilization', '0', '0.05')}
              </>,
            )}

            {flagGroup('Cluster', true, <>{knobNum('numInstances', 'Instances')}</>)}

            {flagGroup(
              'Prefill/decode split',
              false,
              <PdCard values={values} set={set} issueFor={issueFor} />,
            )}

            {flagGroup(
              'Admission & routing',
              false,
              <>
                {knobSel('admissionPolicy', 'Admission policy', ADMISSION_POLICIES)}
                <RoutingCard values={values} setValues={setValues} issueFor={issueFor} />
              </>,
            )}

            {flagGroup(
              'Speculative decoding',
              false,
              <>
                {knobNum('numSpeculativeTokens', 'Draft tokens', '0')}
                {knobNum('speculativeAcceptanceRate', 'Acceptance rate', '0', '0.05')}
                {knobSel('speculativeMethod', 'Method', SPECULATIVE_METHODS)}
              </>,
            )}

            <p className="nrnote">
              These are the blis serving flags for the candidate, starting at blis defaults.
              The declaration below writes every one of them out, so the file reproduces the
              run without depending on what blis defaults to. To compare like with like,
              change only what this candidate is meant to test.
            </p>
          </fieldset>

          <fieldset className="nrsim">
            <legend>Simulation model</legend>
            {knobSel('latencyModel', 'Latency model', LATENCY_MODELS)}
            <p className="nrnote">
              A blis simulator setting, not a deployment property under test. It is how faithfully
              blis models per-request latency, not something this candidate competes on, so it sits
              apart from the serving flags above. It still rides on the candidate record, so the run
              reproduces; changing it does not change which table the run lands in.
            </p>
          </fieldset>
        </form>

        <aside className="nrout">
          <div className="verdictwrap" aria-live="polite">
            {output ? (
              <div className={output.target.group ? 'verdict joins' : 'verdict new'}>
                {output.target.group ? (
                  <>
                    <h3>Joins an existing table</h3>
                    <p>
                      Same work as <code>{output.target.group.groupId}</code>, which holds{' '}
                      {output.target.group.records.length} runs. It becomes row{' '}
                      {output.target.group.records.length + 1} of{' '}
                      <span className="nrtitle">{output.target.group.title}</span>.
                    </p>
                    <p className="nrpath">
                      <code>{output.resultPath}</code>
                    </p>
                  </>
                ) : (
                  <>
                    <h3>Starts a new table</h3>
                    <p>
                      No stored group offers this work, so it opens its own table. Changing the
                      model or hardware alone would still join this workload&apos;s table.
                    </p>
                    <p className="nrpath">
                      <code>results/&lt;group_id&gt;/{output.runId}.json</code>, once the work is
                      hashed into a group_id.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="verdict blocked">
                <h3>Not runnable yet</h3>
                <ul>
                  {issues.map((issue) => (
                    <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {output && (
            <>
              <div className="nrrun">
                <button
                  type="button"
                  className="runbtn"
                  onClick={() => onRun(output)}
                  disabled={running}
                >
                  {running ? 'Running blis…' : 'Run this candidate'}
                </button>
                <span className="nrrunhint">
                  Runs on the server in a few seconds of CPU, then takes you to the board to
                  watch it land as <code>{output.runId}.json</code>.
                </span>
              </div>

              {errorMessage && (
                <div className="runresult err" role="alert">
                  <h3>Did not run</h3>
                  <p>{errorMessage}</p>
                </div>
              )}

              <CliDetail output={output} />
            </>
          )}
        </aside>
      </div>
    </>
  )
}

/**
 * The routing card: the policy as a segmented control (few options, so every one is
 * visible rather than hidden behind a dropdown), and — only for the "weighted" policy —
 * the scorer profile that policy blends. The scorers are multi-select toggles with a
 * weight each, seeded from blis's default profile the first time weighted is chosen and
 * cleared when the policy changes, so a non-weighted candidate declares no profile.
 */
function RoutingCard({
  values,
  setValues,
  issueFor,
}: {
  values: FormValues
  setValues: Dispatch<SetStateAction<FormValues>>
  issueFor: (field: keyof FormValues) => { message: string } | undefined
}) {
  const weighted = values.routingPolicy === 'weighted'
  const selected = new Set(values.routingScorers.map((s) => s.name))

  // Switching to weighted seeds blis's default profile (unless the card already holds one),
  // so it opens on a sensible, reproducible starting point; switching away drops the profile
  // entirely, because blis reads --routing-scorers only for the weighted policy.
  const setPolicy = (policy: string) =>
    setValues((v) => {
      if (policy !== 'weighted') return { ...v, routingPolicy: policy, routingScorers: [] }
      const scorers =
        v.routingScorers.length > 0
          ? v.routingScorers
          : DEFAULT_ROUTING_SCORERS.map((s) => ({ name: s.name, weight: String(s.weight) }))
      return { ...v, routingPolicy: policy, routingScorers: scorers }
    })

  const toggleScorer = (name: string) =>
    setValues((v) => {
      const has = v.routingScorers.some((s) => s.name === name)
      return {
        ...v,
        routingScorers: has
          ? v.routingScorers.filter((s) => s.name !== name)
          : [...v.routingScorers, { name, weight: '1' }],
      }
    })

  const setWeight = (name: string, weight: string) =>
    setValues((v) => ({
      ...v,
      routingScorers: v.routingScorers.map((s) => (s.name === name ? { ...s, weight } : s)),
    }))

  return (
    <>
      <div className="nrrow">
        <span className="nrlabel" id="routing-label">
          Routing policy
        </span>
        <div className="seg seg-wrap" role="radiogroup" aria-labelledby="routing-label">
          {ROUTING_POLICIES.map((policy) => (
            <label key={policy} className={values.routingPolicy === policy ? 'on' : undefined}>
              <input
                type="radio"
                name="routingPolicy"
                value={policy}
                checked={values.routingPolicy === policy}
                onChange={() => setPolicy(policy)}
              />
              {policy}
            </label>
          ))}
        </div>
      </div>

      {weighted && (
        <div className="nrscorers">
          <span className="nrlabel" id="scorers-label">
            Scorers &amp; weights
          </span>
          <div className="tagrow" role="group" aria-labelledby="scorers-label">
            {ROUTING_SCORERS.map((name) => (
              <button
                key={name}
                type="button"
                className="tag"
                aria-pressed={selected.has(name)}
                onClick={() => toggleScorer(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {values.routingScorers.length > 0 && (
            <div className="nrscorerweights">
              {values.routingScorers.map((s) => (
                <label key={s.name} className="nrscorerweight">
                  <span>{s.name}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={s.weight}
                    aria-label={`Weight for ${s.name}`}
                    onChange={(e) => setWeight(s.name, e.target.value)}
                  />
                </label>
              ))}
            </div>
          )}

          {issueFor('routingScorers') && (
            <p className="nrerr">{issueFor('routingScorers')!.message}</p>
          )}

          <p className="nrnote">
            Weighted routing blends these scorers; blis normalizes the weights to sum to 1, so
            they are ratios, not percentages. The default profile is precise-prefix-cache 2,
            queue-depth 1, kv-utilization 1. Only the weighted policy reads them, and a weight is
            a routing input you set, not a number BLIS reports.
          </p>
        </div>
      )}
    </>
  )
}

/**
 * The prefill/decode disaggregation card: how the cluster's instances split into prefill,
 * decode and shared-role pools, the decider that sends a request to a pool, and the KV
 * transfer physics between them. It stays off until a pool count is set — all zero declares
 * no disaggregation — and the pool counts must fit in the cluster (the verdict panel reports
 * a bad topology, since that is a cross-field rule). The transfer knobs open on blis's
 * defaults and only reach the argv when changed.
 */
function PdCard({
  values,
  set,
  issueFor,
}: {
  values: FormValues
  set: <K extends keyof FormValues>(key: K, value: FormValues[K]) => void
  issueFor: (field: keyof FormValues) => { message: string } | undefined
}) {
  const num = (field: keyof FormValues, label: string, step = '1', min = '0') => (
    <>
      <label className="nrrow">
        <span className="nrlabel">{label}</span>
        <input
          type="number"
          min={min}
          step={step}
          value={String(values[field])}
          onChange={(e) => set(field, e.target.value as FormValues[typeof field])}
          aria-invalid={issueFor(field) != null}
        />
      </label>
      {issueFor(field) && <p className="nrerr">{issueFor(field)!.message}</p>}
    </>
  )
  return (
    <>
      {num('prefillInstances', 'Prefill instances')}
      {num('decodeInstances', 'Decode instances')}
      {num('prefillDecodeInstances', 'Shared (prefill+decode) instances')}

      <div className="nrrow">
        <span className="nrlabel" id="pd-decider-label">
          Decider
        </span>
        <div className="seg seg-wrap" role="radiogroup" aria-labelledby="pd-decider-label">
          {PD_DECIDERS.map((d) => (
            <label key={d} className={values.pdDecider === d ? 'on' : undefined}>
              <input
                type="radio"
                name="pdDecider"
                value={d}
                checked={values.pdDecider === d}
                onChange={() => set('pdDecider', d)}
              />
              {d}
            </label>
          ))}
        </div>
      </div>

      {values.pdDecider === 'prefix-threshold' && num('pdPrefixThreshold', 'Prefix threshold (tokens)')}

      {num('pdTransferBandwidth', 'Transfer bandwidth (GB/s)', '0.5')}
      {num('pdTransferBaseLatency', 'Transfer base latency (ms)', '0.01')}

      <div className="nrrow">
        <span className="nrlabel" id="pd-contention-label">
          Transfer contention
        </span>
        <div className="seg" role="radiogroup" aria-labelledby="pd-contention-label">
          {([['off', false], ['on', true]] as const).map(([label, on]) => (
            <label key={label} className={values.pdTransferContention === on ? 'on' : undefined}>
              <input
                type="radio"
                name="pdTransferContention"
                checked={values.pdTransferContention === on}
                onChange={() => set('pdTransferContention', on)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <p className="nrnote">
        Leave the pools at 0 for a single undifferentiated cluster. When set, the prefill,
        decode and shared pools must fit within Instances above, and a split needs both a
        prefill and a decode pool unless you use the shared pool. Transfer bandwidth and base
        latency are the KV handoff physics between pools; they reach the run only when changed
        from blis's defaults (25 GB/s, 0.05 ms).
      </p>
    </>
  )
}

/**
 * The simple inline custom workload (R4): input and output token shape as a gaussian
 * (mean, spread and a min/max clamp), request count, offered load, seed and deadline. It
 * is a guided single-client WorkloadSpec; anything richer (cohorts, other distributions,
 * trace-driven, several clients) is the Workloads tab's job.
 */
function CustomCard({
  values,
  set,
  issueFor,
  loadIsRate,
  onNameEdited,
}: {
  values: FormValues
  set: <K extends keyof FormValues>(key: K, value: FormValues[K]) => void
  issueFor: (field: keyof FormValues) => { message: string } | undefined
  loadIsRate: boolean
  /** Freezes the suggested-name auto-sync once the reader types their own, mirroring the
   * run id field. */
  onNameEdited: () => void
}) {
  const num = (field: keyof FormValues, label: string, step = '1', min = '0') => (
    <>
      <label className="nrrow">
        <span className="nrlabel">{label}</span>
        <input
          type="number"
          min={min}
          step={step}
          value={String(values[field])}
          onChange={(e) => set(field, e.target.value as FormValues[typeof field])}
          aria-invalid={issueFor(field) != null}
        />
      </label>
      {issueFor(field) && <p className="nrerr">{issueFor(field)!.message}</p>}
    </>
  )
  // Two related whole-number fields share one row, so the four token-shape knobs per stream
  // read as two compact pairs (mean ± stdev, min / max) rather than eight stacked rows.
  const duo = (a: keyof FormValues, aLabel: string, b: keyof FormValues, bLabel: string) => (
    <div className="nrduo">
      {([[a, aLabel], [b, bLabel]] as const).map(([field, label]) => (
        <label className="nrsub" key={field}>
          <span className="nrlabel">{label}</span>
          <input
            type="number"
            min="1"
            step="1"
            value={String(values[field])}
            onChange={(e) => set(field, e.target.value as FormValues[typeof field])}
            aria-invalid={issueFor(field) != null}
          />
          {issueFor(field) && <p className="nrerr">{issueFor(field)!.message}</p>}
        </label>
      ))}
    </div>
  )
  return (
    <div className="nrcard">
      <label className="nrrow">
        <span className="nrlabel">Name</span>
        <input
          type="text"
          value={values.customName}
          placeholder="my-workload"
          spellCheck={false}
          onChange={(e) => {
            onNameEdited()
            set('customName', e.target.value)
          }}
          aria-invalid={issueFor('customName') != null}
        />
      </label>
      {issueFor('customName') && <p className="nrerr">{issueFor('customName')!.message}</p>}

      {duo('promptTokens', 'Input mean', 'promptTokensStdev', '± stdev')}
      {duo('promptTokensMin', 'Input min', 'promptTokensMax', 'Input max')}
      {duo('outputTokens', 'Output mean', 'outputTokensStdev', '± stdev')}
      {duo('outputTokensMin', 'Output min', 'outputTokensMax', 'Output max')}
      {num('numRequests', 'Requests', '1', '1')}

      <div className="nrrow">
        <span className="nrlabel" id="loadkind-label">
          Load
        </span>
        <div className="seg" role="radiogroup" aria-labelledby="loadkind-label">
          {(['rate', 'concurrency'] as const).map((kind) => (
            <label key={kind} className={values.loadKind === kind ? 'on' : undefined}>
              <input
                type="radio"
                name="loadKind"
                value={kind}
                checked={values.loadKind === kind}
                onChange={() => set('loadKind', kind)}
              />
              {kind === 'rate' ? 'Arrival rate' : 'Concurrency'}
            </label>
          ))}
        </div>
      </div>

      {num(
        'loadValue',
        loadIsRate ? 'Requests per second' : 'In-flight sessions',
        loadIsRate ? '0.5' : '1',
      )}
      {num('seed', 'Seed')}
      {num('requestTimeoutS', 'Deadline (s, negative disables)', '1', undefined)}

      <p className="nrnote">
        Gaussian token distribution, one client at a constant/closed-loop arrival: the same
        subset <code>runs.yaml</code> takes. Saved to the catalog under this name when you run
        it, so you can reuse it. For cohorts, other distributions, or trace-driven work,{' '}
        <a href="#/workloads">author a workload in the Workloads tab</a> and select it above.
      </p>
    </div>
  )
}

/**
 * The CLI escape hatch. A distribution declaration is a runnable runs.yaml plus the blis
 * argv; a spec declaration cannot be a `leaderboard run` input (internal/spec.Load rejects
 * an inline workload-spec), so it is offered as a record reproduced by the Run button or by
 * running blis directly with the argv, never as a file the CLI would refuse.
 */
function CliDetail({ output }: { output: Output }) {
  const isSpec = output.group.workload.type === 'workload-spec'
  return (
    <details className="nrargv">
      <summary>Prefer the CLI, or want the declaration?</summary>
      <div className="nrclidetail">
        {isSpec ? (
          <CopyBlock
            label="Declaration (record)"
            hint="A record of this workload-spec run. `leaderboard run` does not read an inline spec yet; reproduce it with the Run button above, or by running blis directly with the argv below."
            text={output.yamlFile}
          />
        ) : (
          <>
            <CopyBlock label="runs.new.yaml" hint="Save this at the repo root." text={output.yamlFile} />
            <CopyBlock
              label="Run it yourself"
              hint="Needs bin/leaderboard and a built simulator (make build && make blis)."
              text={`./bin/leaderboard run -runs runs.new.yaml\n`}
            />
            {output.target.group && (
              <CopyBlock
                label="Or add the row to runs.yaml"
                hint={`The work already matches, so ${output.target.group.groupId} takes it as one more row.`}
                text={`${output.yamlRow}\n`}
              />
            )}
          </>
        )}
        <p className="nrargvnote">The blis invocation this produces:</p>
        <pre>
          <code>{shellLines(output.argv)}</code>
        </pre>
        <p className="nrargvnote">
          {isSpec ? (
            <>
              <code>--workload-spec</code> points at a temp file the runner writes from the inline
              spec, and <code>--metrics-path</code> at another. The argv that actually ran is
              stored in the result.
            </>
          ) : (
            <>
              <code>--metrics-path</code> is a temporary file the runner picks; the argv that
              actually ran is stored in the result.
            </>
          )}
        </p>
      </div>
    </details>
  )
}
