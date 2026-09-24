import { useCallback, useEffect, useRef, useState } from 'react'
import { getModelConfig, listModels, type ModelDetail, type ModelInfo } from '../models'
import { collapseHardwareAliases, listHardware, type HardwareInfo } from '../hardware'
import type { WorkloadGroup } from '../load'
import { CopyBlock } from './CopyBlock'
import { Workloads } from './Workloads'

/**
 * The Catalog page: the pieces a run is composed from, under three tabs. Models come from the
 * blis-catalog clone (GET /api/models) and accelerators from the upstream hardware_config.json
 * (GET /api/hardware) — both read live, the same files blis resolves a run against, so neither
 * is a hand-maintained snapshot. Workloads are the reusable definitions of the work offered,
 * authored and browsed here (the one read-write tab). Like the Leaderboard's live results, each
 * tab is read from the server; without one it says why it is empty rather than showing a blank
 * page. A model's full config.json is fetched only when a reader opens it (GET
 * /api/models/config), so the list stays light.
 */

/** The three inner tabs. The choice lives in the hash (#/catalog/hardware) so it survives a
 * reload and can be linked to, like the rest of the app's routes. */
type CatalogTab = 'models' | 'hardware' | 'workloads'

/** Which inner tab the hash names. The old top-level #/models, #/hardware and #/workloads deep
 * links still resolve, so bookmarks and the Declare form's workload hand-off keep working.
 * Workloads is the first tab and the default, so a bare #/catalog opens there. */
export function catalogTabFromHash(hash: string): CatalogTab {
  if (hash.startsWith('#/catalog/hardware') || hash.startsWith('#/hardware')) return 'hardware'
  if (hash.startsWith('#/catalog/models') || hash.startsWith('#/models')) return 'models'
  return 'workloads'
}

const TAB_HASH: Record<CatalogTab, string> = {
  models: '#/catalog/models',
  hardware: '#/catalog/hardware',
  workloads: '#/catalog/workloads',
}

export function Catalog({ boardWorkloads }: { boardWorkloads: WorkloadGroup[] }) {
  const [tab, setTab] = useState<CatalogTab>(() => catalogTabFromHash(window.location.hash))

  // Follow the hash both ways: a tab click rewrites it, and back/forward or a pasted link
  // updates the selected tab.
  useEffect(() => {
    const sync = () => setTab(catalogTabFromHash(window.location.hash))
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const select = (next: CatalogTab) => {
    window.location.hash = TAB_HASH[next]
    setTab(next)
  }

  const tabs: { id: CatalogTab; label: string }[] = [
    { id: 'workloads', label: 'Workloads' },
    { id: 'models', label: 'Models' },
    { id: 'hardware', label: 'Hardware' },
  ]

  return (
    <>
      <h2 className="viewhead">Catalog</h2>
      <p className="dek tab-intro">
        The pieces a run is composed from: the workloads you offer, and the models and hardware
        BLIS runs them on. Pick from these when you <a href="#/declare">declare a run</a>.
      </p>
      <div className="subtabs" role="tablist" aria-label="Catalog">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`subtab${tab === t.id ? ' active' : ''}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'models' ? (
        <ModelsPanel />
      ) : tab === 'hardware' ? (
        <HardwarePanel />
      ) : (
        <Workloads boardWorkloads={boardWorkloads} />
      )}
    </>
  )
}

/** A section that could not be read points at the run server, the way the Workloads tab does
 * when its catalog is unreachable. */
function CatalogError({ message }: { message: string }) {
  return (
    <p className="dek issue">
      {message} The catalog needs the run server: <code>make build &amp;&amp; ./bin/leaderboard serve</code>.
    </p>
  )
}

// ---------- Models ----------

/** The load state of one model's on-demand config detail. */
type ConfigState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detail: ModelDetail }

/** The Models tab body: the models BLIS can run, grouped by provider, each openable to reveal
 * its config.json in place. The Catalog page owns the heading and tab bar above it. */
function ModelsPanel() {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Which model is open (only one at a time), and the fetched detail per model, cached so
  // reopening a model does not refetch. A ref tracks which have been requested so the load
  // effect fires exactly once per model.
  const [expanded, setExpanded] = useState<string | null>(null)
  const [configs, setConfigs] = useState<Record<string, ConfigState>>({})
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    listModels()
      .then((m) => {
        if (live) {
          setModels(m)
          setError(null)
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [])

  // Load the open model's config the first time it is opened. Keyed on `expanded` alone; the
  // requested-set guard makes it fire once per model, and setting state after unmount is a
  // no-op in React 18, so no live flag is needed here.
  useEffect(() => {
    const name = expanded
    if (!name || requested.current.has(name)) return
    requested.current.add(name)
    setConfigs((c) => ({ ...c, [name]: { status: 'loading' } }))
    getModelConfig(name)
      .then((detail) => setConfigs((c) => ({ ...c, [name]: { status: 'ready', detail } })))
      .catch((e) =>
        setConfigs((c) => ({
          ...c,
          [name]: { status: 'error', message: e instanceof Error ? e.message : String(e) },
        })),
      )
  }, [expanded])

  const toggle = useCallback((name: string) => {
    setExpanded((cur) => (cur === name ? null : name))
  }, [])

  if (error) return <CatalogError message={error} />
  if (models === null) return <p className="dek">Reading the model catalog.</p>
  return (
    <ModelsList
      models={models}
      expanded={expanded}
      onToggle={toggle}
      configFor={(name) => configs[name]}
    />
  )
}

/**
 * The models, grouped by provider. A model's canonical name is `<org>/<model>`, so the org is
 * a real dimension worth grouping on: the reader scans by provider (qwen, mistralai,
 * meta-llama) rather than one long flat list. A mixture-of-experts model wears a badge, since
 * that is what turns the MoE serving knobs on in the Declare form; dense models wear none.
 * Each model is a button that opens its config beneath it in place.
 */
export function ModelsList({
  models,
  expanded,
  onToggle,
  configFor,
}: {
  models: ModelInfo[]
  expanded: string | null
  onToggle: (name: string) => void
  /** The load state of a model's config, or undefined before it has been opened. */
  configFor: (name: string) => ConfigState | undefined
}) {
  if (models.length === 0) {
    return (
      <p className="dek empty">No models in the catalog. Check that BLIS_CATALOG points at a clone.</p>
    )
  }
  const orgs = groupByOrg(models)
  return (
    <div className="model-orgs">
      {orgs.map(({ org, entries }) => (
        <div className="model-org" key={org}>
          <h3 className="model-org-name">{org}</h3>
          <ul className="model-list">
            {entries.map((m) => {
              const open = m.name === expanded
              return (
                <li className={`model-item${open ? ' open' : ''}`} key={m.name}>
                  <button
                    type="button"
                    className="model-face"
                    aria-expanded={open}
                    onClick={() => onToggle(m.name)}
                  >
                    <Caret open={open} />
                    <span className="mono model-name">{m.name}</span>
                    {m.moe && (
                      <span className="badge moe" title="Mixture of experts">
                        MoE
                      </span>
                    )}
                  </button>
                  {open && <div className="model-config">{renderConfig(configFor(m.name))}</div>}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** The body under an open model: a spinner-free load note, an error pointing at the server, or
 * the config detail once it has arrived. */
function renderConfig(state: ConfigState | undefined) {
  if (!state || state.status === 'loading') return <p className="dek">Reading the config.</p>
  if (state.status === 'error') return <CatalogError message={state.message} />
  return <ModelConfigView detail={state.detail} />
}

/** A caret that points right when closed and down when open, in the stroke vocabulary of the
 * app's other line icons. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`model-caret${open ? ' open' : ''}`}
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/**
 * One opened model's detail, side by side: the model.yaml provenance as tags on the left, and
 * the config.json blis reads on the right. The tags summarize where the weights come from
 * (source block); config.json (the architecture) may be absent, and a model that ships none
 * says so rather than showing an empty block. On a narrow screen the two columns stack.
 */
export function ModelConfigView({ detail }: { detail: ModelDetail }) {
  return (
    <div className="model-detail">
      <div className="model-meta">
        <h5 className="model-detail-head">model.yaml</h5>
        <ModelTags source={detail.source} />
      </div>
      <div className="model-detail-config">
        {detail.config ? (
          <CopyBlock
            label="config.json"
            hint="The model architecture blis reads."
            text={detail.config}
          />
        ) : (
          <p className="dek empty">This model ships no config.json.</p>
        )}
      </div>
    </div>
  )
}

/** The model.yaml source block as tags: one labeled tag per field that is present (an absent
 * field is omitted rather than shown empty). Each field carries a fixed tone from the app's
 * tag palette so the columns read as a color-coded key, not a wall of grey. The repo links to
 * its HuggingFace page when that is the provider, since that is where the weights actually live. */
function ModelTags({ source }: { source: ModelDetail['source'] }) {
  const isHF = source.provider.toLowerCase() === 'huggingface'
  return (
    <dl className="mtags">
      {source.provider && <Tag tone="teal" label="provider" value={source.provider} />}
      {source.repo && (
        <Tag
          tone="purple"
          label="repo"
          value={source.repo}
          href={isHF ? `https://huggingface.co/${source.repo}` : undefined}
        />
      )}
      {source.revision && <Tag tone="amber" label="revision" value={source.revision} />}
      {source.retrieved && <Tag tone="neutral" label="retrieved" value={source.retrieved} />}
    </dl>
  )
}

/** One provenance tag: a colored label over a mono value, the value optionally a link. The
 * tone tints the whole chip from the shared tag palette. */
function Tag({
  tone,
  label,
  value,
  href,
}: {
  tone: 'teal' | 'purple' | 'amber' | 'neutral'
  label: string
  value: string
  href?: string
}) {
  return (
    <div className={`mtag mtag-${tone}`}>
      <dt className="mtag-key">{label}</dt>
      <dd className="mtag-val mono">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/** Models bucketed by their org prefix, orgs sorted, each org's models kept in incoming
 * (already name-sorted) order. */
function groupByOrg(models: ModelInfo[]): { org: string; entries: ModelInfo[] }[] {
  const byOrg = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const org = m.name.includes('/') ? m.name.slice(0, m.name.indexOf('/')) : m.name
    const bucket = byOrg.get(org)
    if (bucket) bucket.push(m)
    else byOrg.set(org, [m])
  }
  return [...byOrg.keys()].sort().map((org) => ({ org, entries: byOrg.get(org)! }))
}

// ---------- Hardware ----------

/** The Hardware tab body: the accelerators BLIS can run on, one spec card each. The Catalog
 * page owns the heading and tab bar above it. */
function HardwarePanel() {
  const [hardware, setHardware] = useState<HardwareInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listHardware()
      .then((h) => {
        if (live) {
          setHardware(h)
          setError(null)
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [])

  if (error) return <CatalogError message={error} />
  if (hardware === null) return <p className="dek">Reading the hardware catalog.</p>
  return <HardwareCatalog hardware={hardware} />
}

/**
 * The accelerators, one card each with the numeric spec blis reads. Names whose spec is
 * byte-identical are one accelerator, not two candidates (blis would produce a duplicate row),
 * so an alias group is collapsed into a single card that names the others rather than repeating
 * the spec.
 */
export function HardwareCatalog({ hardware }: { hardware: HardwareInfo[] }) {
  if (hardware.length === 0) {
    return <p className="dek empty">No accelerators in hardware_config.json.</p>
  }
  const cards = collapseHardwareAliases(hardware)
  return (
    <div className="hw-grid">
      {cards.map((card) => (
        <article className="hw-card" key={card.name}>
          <header className="hw-card-head">
            <h3 className="mono">{card.name}</h3>
            {card.aliases.length > 0 && <span className="hw-alias">also {card.aliases.join(', ')}</span>}
          </header>
          <dl className="hw-specs">
            {SPEC_FIELDS.map((f) => {
              const v = card.spec[f.key]
              return v === undefined ? null : (
                <div className="hw-spec" key={f.key}>
                  <dt>{f.label}</dt>
                  <dd className="mono">{f.format(v)}</dd>
                </div>
              )
            })}
          </dl>
        </article>
      ))}
    </div>
  )
}

/** The hardware_config.json fields worth showing, in reading order, with human labels and
 * units. Unknown keys are ignored so an upstream field added or renamed does not break the
 * page; the values are blis's own numbers, shown as-is. */
const SPEC_FIELDS: { key: string; label: string; format: (v: number) => string }[] = [
  { key: 'MemoryGiB', label: 'Memory', format: (v) => `${v} GiB` },
  { key: 'BwPeakTBs', label: 'Memory bandwidth', format: (v) => `${v} TB/s` },
  { key: 'TFlopsPeak', label: 'Compute (BF16/FP16)', format: (v) => `${v} TFLOPs` },
  // A card with no FP8 path reports 0; say "none" rather than a bare zero that reads like a
  // measured spec.
  { key: 'TFlopsFP8', label: 'Compute (FP8)', format: (v) => (v > 0 ? `${v} TFLOPs` : 'none') },
  { key: 'IntraNodeBwGBps', label: 'Intra-node bandwidth', format: (v) => `${v} GB/s` },
  { key: 'InterNodeBwGBps', label: 'Inter-node bandwidth', format: (v) => `${v} GB/s` },
  { key: 'mfuPrefill', label: 'MFU (prefill)', format: (v) => `${v}` },
  { key: 'mfuDecode', label: 'MFU (decode)', format: (v) => `${v}` },
]
