import type { WorkloadGroup } from '../load'
import { crossRef, profileKnobs, profileSummary, specText, type ProfileBody } from '../workloads'
import { CopyBlock } from './CopyBlock'

interface Props {
  profiles: ProfileBody[]
  /** The board's workloads, so each card can show how many models/runs already exist
   * under it (matched by workloadKey). */
  boardWorkloads: WorkloadGroup[]
  /** The name of the card whose full spec is shown below the gallery, or null. Controlled
   * by the parent so the selection survives a catalog refresh. */
  selected?: string | null
  onSelect?: (name: string) => void
  onDelete: (name: string) => void
}

/**
 * The catalog browser: every saved workload as a row in a list — the four shipped presets
 * (§11) and the user's own profiles together, all shown at once rather than in a gallery. A
 * row shows the name (with a read-only badge on a preset), the one-line work summary
 * (reusing workloadTitle's phrasing so it cannot drift), the variant it is stored as, and a
 * cross-reference to the runs already on the board under it. Choosing a row opens its
 * complete definition in the detail panel below: the full WorkloadSpec for a spec-backed
 * profile, the flat fields for a distribution one — nothing about a workload is hidden, the
 * way disqualified runs are never hidden elsewhere. A profile can be deleted (a preset
 * cannot); a saved workload is not edited in place, since runs already filed under it keep
 * their own copy of the work.
 */
export function WorkloadCatalog({
  profiles,
  boardWorkloads,
  selected = null,
  onSelect = () => {},
  onDelete,
}: Props) {
  const chosen = profiles.find((p) => p.name === selected) ?? null

  // Most-exercised workload first: the one with the most runs on the board leads the list,
  // so the catalog opens on what is most compared. Ties keep their incoming order
  // (Array.sort is stable), so the ordering only ever promotes the busy workloads.
  const ordered = profiles
    .map((p) => ({ p, xref: crossRef(p, boardWorkloads) }))
    .sort((a, b) => b.xref.runs - a.xref.runs)

  return (
    <section className="catalog">
      <h2>Saved workloads</h2>

      {profiles.length === 0 ? (
        <p className="dek empty">No workloads yet. Fill in the form above to author one.</p>
      ) : (
        <>
          <h3 className="wlist-head">Select a workload</h3>
          <ul className="wlist">
            {ordered.map(({ p, xref }) => {
              const isSel = p.name === selected
              return (
                // A fixed id on the selected row (there is only ever one) is the scroll
                // anchor for the #/workloads?workload=<name> deep link, robust to whatever
                // characters a workload name carries.
                <li
                  key={p.name}
                  id={isSel ? 'wrow-selected' : undefined}
                  className={`wrow${isSel ? ' selected' : ''}`}
                >
                  <button
                    type="button"
                    className="wrow-face"
                    aria-pressed={isSel}
                    onClick={() => onSelect(p.name)}
                  >
                    <span className="wrow-name mono">
                      {p.name}
                      {p.builtin && (
                        <span className="badge builtin" title="A shipped preset — read-only">
                          preset
                        </span>
                      )}
                    </span>
                    <span className="wrow-summary">{profileSummary(p)}</span>
                    <span className="wrow-meta">
                      <span className={`variant variant-${p.workload.type}`}>{p.workload.type}</span>
                      <span className="xref">
                        {xref.runs === 0
                          ? 'no runs yet'
                          : `${xref.runs} run${xref.runs === 1 ? '' : 's'} · ${xref.models} model${
                              xref.models === 1 ? '' : 's'
                            }`}
                      </span>
                    </span>
                  </button>
                  <div className="wrow-actions">
                    <button
                      type="button"
                      className="wcard-del"
                      onClick={() => onDelete(p.name)}
                      disabled={p.builtin}
                      title={p.builtin ? 'A preset cannot be deleted' : `Delete ${p.name}`}
                    >
                      <TrashIcon />
                      Delete
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          {chosen ? (
            <WorkloadDetail profile={chosen} />
          ) : (
            <p className="dek pick-hint">Pick a workload above to see its full spec here.</p>
          )}
        </>
      )}
    </section>
  )
}

/** A stroked trash glyph for the Delete action, inheriting the button's current color so it
 * shifts with the button on hover and disabled states. */
function TrashIcon() {
  return (
    <svg
      className="wcard-del-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

/**
 * The detail panel for the chosen card: the group knobs (seed, horizon, timeout) above the
 * work itself. A spec-backed profile shows its complete WorkloadSpec YAML, copyable; a
 * distribution profile — which has no spec — shows its flat fields instead.
 */
function WorkloadDetail({ profile }: { profile: ProfileBody }) {
  const yaml = specText(profile)
  return (
    <div className="wdetail">
      <div className="wdetail-head">
        <h3 className="mono">
          {profile.name}
          {profile.builtin && (
            <span className="badge builtin" title="A shipped preset — read-only">
              preset
            </span>
          )}
        </h3>
        <p className="wdetail-knobs">{profileKnobs(profile)}</p>
      </div>
      {yaml != null ? (
        <CopyBlock
          label="WorkloadSpec"
          hint="The complete blis spec this workload runs. The model is chosen and injected when you declare a run."
          text={yaml}
        />
      ) : (
        <DistributionDetail workload={profile.workload} />
      )}
    </div>
  )
}

/** The flat distribution fields, as a definition list — the whole of a distribution
 * profile's work definition (it carries no WorkloadSpec). */
function DistributionDetail({ workload }: { workload: ProfileBody['workload'] }) {
  const load = workload.load
  const loadText = load ? `${load.value} ${load.kind === 'concurrency' ? 'concurrent sessions' : 'req/s'}` : '—'
  return (
    <dl className="wdetail-fields">
      <div>
        <dt>Requests</dt>
        <dd className="mono">{workload.num_requests}</dd>
      </div>
      <div>
        <dt>Offered load</dt>
        <dd className="mono">{loadText}</dd>
      </div>
      <div>
        <dt>Prompt tokens</dt>
        <dd className="mono">
          {workload.prompt_tokens} ± {workload.prompt_tokens_stdev}
        </dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd className="mono">
          {workload.output_tokens} ± {workload.output_tokens_stdev}
        </dd>
      </div>
    </dl>
  )
}
