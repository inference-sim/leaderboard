import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  contextMeterFraction,
  filterModels,
  formatContext,
  getModelConfig,
  groupByFamily,
  listModels,
  modelOf,
  orgOf,
  precision,
  type ModelDetail,
  type ModelInfo,
  type ModelKind,
} from '../models'
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
  // The toolbar's controls: a free-text query and the dense/MoE filter.
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ModelKind>('all')

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
  // An empty catalog is a misconfiguration, distinct from a filter that matched nothing:
  // ModelsList carries the BLIS_CATALOG pointer for the former.
  if (models.length === 0) {
    return <ModelsList models={[]} expanded={expanded} onToggle={toggle} configFor={(n) => configs[n]} />
  }
  const shown = filterModels(models, query, kind)
  return (
    <>
      <ModelsToolbar
        query={query}
        onQuery={setQuery}
        kind={kind}
        onKind={setKind}
        shown={shown.length}
        total={models.length}
      />
      {shown.length === 0 ? (
        <p className="dek empty">No models match that filter.</p>
      ) : (
        <ModelsList
          models={shown}
          expanded={expanded}
          onToggle={toggle}
          configFor={(name) => configs[name]}
        />
      )}
    </>
  )
}

/** The Models toolbar: a name/family search, a dense/MoE filter, and a live count of how
 * many of the catalog's models the current controls show. */
function ModelsToolbar({
  query,
  onQuery,
  kind,
  onKind,
  shown,
  total,
}: {
  query: string
  onQuery: (q: string) => void
  kind: ModelKind
  onKind: (k: ModelKind) => void
  shown: number
  total: number
}) {
  const kinds: { id: ModelKind; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'dense', label: 'Dense' },
    { id: 'moe', label: 'MoE' },
  ]
  return (
    <div className="model-toolbar">
      <label className="model-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter by name, family, or provider"
          aria-label="Filter models"
        />
      </label>
      <div className="model-seg" role="group" aria-label="Architecture">
        {kinds.map((k) => (
          <button
            key={k.id}
            type="button"
            className={kind === k.id ? 'on' : ''}
            aria-pressed={kind === k.id}
            onClick={() => onKind(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <span className="model-count mono">
        {shown === total ? `${total} models` : `${shown} of ${total}`}
      </span>
    </div>
  )
}

/**
 * The models the Catalog offers, grouped by family. Family (Llama, Qwen, GLM, …) is derived
 * from the model name rather than the provider org, since the org splits a family across
 * vendors (Llama-4-Scout ships under redhatai, not meta-llama). Each family's cards sit in a
 * grid beside a rail naming it; a card shows the architecture at a glance and opens in place
 * to reveal its config.json. A mixture-of-experts model is badged MoE — the flag that turns
 * the MoE serving knobs on in the Declare form — and a dense one Dense.
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
  return (
    <div className="model-fams">
      {groupByFamily(models).map((fam) => (
        <section className="mfam" key={fam.key}>
          <div className="mfam-rail">
            <h3 className="mfam-name">{fam.label}</h3>
            <p className="mfam-meta">
              {fam.models.length} model{fam.models.length > 1 ? 's' : ''}
            </p>
            <div className="mfam-rule" aria-hidden="true" />
          </div>
          <div className="mgrid">
            {fam.models.map((m) => (
              <ModelCard
                key={m.name}
                model={m}
                open={m.name === expanded}
                onToggle={onToggle}
                config={configFor(m.name)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * One model as a spec card: the org kicker, model name, and architecture over a log-scale
 * context-window meter and the numbers that decide how it runs (layers, hidden size,
 * attention shape, precision, and — for MoE — the active/total expert split). The card face
 * is a button; opening it reveals the model.yaml provenance and full config.json beneath.
 */
function ModelCard({
  model,
  open,
  onToggle,
  config,
}: {
  model: ModelInfo
  open: boolean
  onToggle: (name: string) => void
  config: ConfigState | undefined
}) {
  const spec = model.spec ?? {}
  const org = orgOf(model.name)
  const context = formatContext(spec.context)
  const meterPct = spec.context ? Math.max(2, contextMeterFraction(spec.context) * 100) : 0
  return (
    <div className={`mcard${open ? ' open' : ''}`}>
      <button
        type="button"
        className="mcard-face"
        aria-expanded={open}
        onClick={() => onToggle(model.name)}
      >
        <div className="mcard-top">
          <div className="mcard-id">
            {org && <div className="mcard-org mono">{org}</div>}
            <div className="mcard-name mono">{modelOf(model.name)}</div>
            {spec.arch && <div className="mcard-arch">{spec.arch}</div>}
          </div>
          <span className={`badge ${model.moe ? 'moe' : 'dense'}`}>
            {model.moe ? 'MoE' : 'Dense'}
          </span>
        </div>
        <div className="mcard-ctx">
          <div className="mcard-ctx-row">
            <span className="mcard-ctx-label">Context window</span>
            <span className={`mcard-ctx-val mono${context ? '' : ' na'}`}>
              {context ?? 'not stated'}
            </span>
          </div>
          <div className="mcard-meter">
            <div className="mcard-meter-fill" style={{ width: `${meterPct}%` }} />
          </div>
          <div className="mcard-meter-scale mono">
            <span>4K</span>
            <span>10M</span>
          </div>
        </div>
        <ModelSpecs model={model} />
      </button>
      {open && <div className="mcard-detail">{renderConfig(config)}</div>}
    </div>
  )
}

/** The at-a-glance spec rows on a card face. Each row appears only when config.json carried
 * its number, so a card never shows a fabricated zero; the Experts row is MoE-only. */
function ModelSpecs({ model }: { model: ModelInfo }) {
  const spec = model.spec ?? {}
  const prec = precision(model)
  const rows: ReactNode[] = []
  if (spec.layers) rows.push(<SpecRow key="layers" label="Layers" value={fmtInt(spec.layers)} />)
  if (spec.hidden) rows.push(<SpecRow key="hidden" label="Hidden" value={fmtInt(spec.hidden)} />)
  if (spec.heads)
    rows.push(<SpecRow key="attn" label="Attention" value={attention(spec.heads, spec.kvHeads)} />)
  if (prec)
    rows.push(
      <SpecRow
        key="prec"
        label="Precision"
        value={
          <>
            {prec.label}
            {prec.derived && (
              <span className="mcard-note" title="from the model name; not in config.json">
                *
              </span>
            )}
          </>
        }
      />,
    )
  if (model.moe && spec.experts)
    rows.push(
      <SpecRow
        key="experts"
        label="Experts"
        wide
        value={`${spec.active ? `${spec.active} active` : '—'} / ${fmtInt(spec.experts)} total`}
      />,
    )
  if (rows.length === 0) return null
  return <dl className="mcard-specs">{rows}</dl>
}

/** One label/value spec row, the value in mono like the numbers elsewhere on the board. */
function SpecRow({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={`mcard-spec${wide ? ' wide' : ''}`}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  )
}

/** The attention shape: query heads over KV heads, with the grouped-query ratio noted when
 * they differ (32 / 8 ·4×). KV heads absent leaves just the query head count. */
function attention(heads: number, kv: number | undefined): ReactNode {
  if (!kv) return String(heads)
  const gqa = heads !== kv ? Math.round(heads / kv) : 0
  return (
    <>
      {heads} / {kv}
      {gqa > 1 && (
        <span className="mcard-note" title="grouped-query attention: query heads per KV group">
          {' '}
          ·{gqa}×
        </span>
      )}
    </>
  )
}

/** fmtInt renders a count with thousands separators, tabular in the card grid. */
function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

/** The body under an open model: a spinner-free load note, an error pointing at the server, or
 * the config detail once it has arrived. */
function renderConfig(state: ConfigState | undefined) {
  if (!state || state.status === 'loading') return <p className="dek">Reading the config.</p>
  if (state.status === 'error') return <CatalogError message={state.message} />
  return <ModelConfigView detail={state.detail} />
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
