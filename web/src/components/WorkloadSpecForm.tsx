import {
  ARRIVAL_PROCESSES,
  CATEGORIES,
  DIST_PARAMS,
  DIST_TYPES,
  SLO_CLASSES,
  changeDistType,
  getBool,
  getNum,
  getStr,
  removeAt,
  setBool,
  setNum,
  setPath,
  setStr,
  type Path,
  type SpecObject,
} from '../spec'
import { Select } from './Select'

interface Props {
  /** The parsed spec, or null when the YAML pane holds something unparseable. */
  obj: SpecObject | null
  /** Why obj is null — shown in place of the fields. */
  error: string | null
  /** Called with the next spec object on any field edit. */
  onChange: (next: SpecObject) => void
}

/** bind makes the controlled-input props for a field at `path`, reading from and writing
 * back to `obj`. Shared by the top-level fields and each client's fields. */
function bind(obj: SpecObject, onChange: (next: SpecObject) => void) {
  return {
    str: (path: Path) => ({
      value: getStr(obj, path),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        onChange(setStr(obj, path, e.target.value)),
    }),
    num: (path: Path) => ({
      value: getNum(obj, path),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(setNum(obj, path, e.target.value)),
    }),
    bool: (path: Path) => ({
      checked: getBool(obj, path),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(setBool(obj, path, e.target.checked)),
    }),
  }
}

/**
 * The form half of the editor: the common WorkloadSpec fields — the top-level workload
 * and one fieldset per client — bound to the parsed object by path. Clients are a list,
 * so each has a Remove and there is an Add. Everything the form does not surface
 * (cohorts, multimodal, reasoning, lifecycle) still round-trips through the YAML pane,
 * which edits the same object. When the YAML cannot be parsed the fields step aside for
 * the error, since there is no object to bind to.
 */
export function WorkloadSpecForm({ obj, error, onChange }: Props) {
  if (!obj) {
    return (
      <div className="spec-form">
        <p className="issue">{error ?? 'The spec cannot be read.'}</p>
        <p className="dek">Fix the YAML on the right and the form returns.</p>
      </div>
    )
  }

  const b = bind(obj, onChange)
  const clients = Array.isArray(obj.clients) ? (obj.clients as SpecObject[]) : []

  return (
    <div className="spec-form">
      <fieldset>
        <legend>Workload</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="sf-version">version</label>
            <input id="sf-version" {...b.str(['version'])} />
          </div>
          <div className="field">
            <label htmlFor="sf-category">category</label>
            <Select
              id="sf-category"
              value={getStr(obj, ['category'])}
              onChange={(v) => onChange(setStr(obj, ['category'], v))}
              options={CATEGORIES.map((c) => ({ value: c, label: c === '' ? '(unset)' : c }))}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="sf-rate">aggregate_rate (req/s, 0 = per-window)</label>
            <input id="sf-rate" type="number" {...b.num(['aggregate_rate'])} />
          </div>
          <div className="field">
            <label htmlFor="sf-num">num_requests (0 = unlimited)</label>
            <input id="sf-num" type="number" {...b.num(['num_requests'])} />
          </div>
        </div>
      </fieldset>

      {clients.map((_, i) => (
        <ClientFields
          key={i}
          obj={obj}
          index={i}
          onChange={onChange}
          onRemove={() => onChange(removeAt(obj, ['clients'], i))}
        />
      ))}

      {clients.length === 0 && (
        <p className="dek">
          No <code>clients</code> yet — use Add client below, or define <code>cohorts</code> in the YAML pane.
        </p>
      )}
    </div>
  )
}

interface ClientProps {
  obj: SpecObject
  index: number
  onChange: (next: SpecObject) => void
  onRemove: () => void
}

/** One client's fieldset. Its inputs are addressed at ['clients', index, …] and their DOM
 * ids carry the index so several clients coexist without colliding. */
function ClientFields({ obj, index, onChange, onRemove }: ClientProps) {
  const b = bind(obj, onChange)
  const base: Path = ['clients', index]
  const id = (suffix: string) => `sf-${index}-${suffix}`

  // The load knob is one choice with two shapes: a rate share (rate_fraction) or a
  // closed-loop concurrency, mutually exclusive in blis. Switching drops the other so
  // the two never coexist.
  const loadKind: 'rate' | 'concurrency' = getNum(obj, [...base, 'concurrency']) !== '' ? 'concurrency' : 'rate'
  const loadPath: Path = [...base, loadKind === 'concurrency' ? 'concurrency' : 'rate_fraction']
  const switchLoad = (next: 'rate' | 'concurrency') => {
    const cleared = setPath(obj, [...base, next === 'rate' ? 'concurrency' : 'rate_fraction'], undefined)
    onChange(setPath(cleared, [...base, next === 'rate' ? 'rate_fraction' : 'concurrency'], 1))
  }

  // A distribution row: a type select, then one numeric field per parameter blis requires
  // for that type (mu/sigma for lognormal, mean/std_dev/min/max for gaussian, …). Changing
  // the type resets the params to that type's set, so the spec stays valid.
  const distRow = (kind: 'input' | 'output') => {
    const distPath: Path = [...base, `${kind}_distribution`]
    const type = getStr(obj, [...distPath, 'type']) || 'lognormal'
    const params = DIST_PARAMS[type] ?? []
    return (
      <div className="field-row">
        <div className="field">
          <label htmlFor={id(`${kind}-type`)}>{kind}_distribution.type</label>
          <Select
            id={id(`${kind}-type`)}
            value={type}
            onChange={(v) => onChange(changeDistType(obj, distPath, v))}
            options={DIST_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </div>
        {params.map((p) => (
          <div className="field" key={p}>
            <label htmlFor={id(`${kind}-${p}`)}>{`${kind} ${p}`}</label>
            <input id={id(`${kind}-${p}`)} type="number" {...b.num([...distPath, 'params', p])} />
          </div>
        ))}
        {params.length === 0 && (
          <div className="field">
            <p className="dek">Set the {type} file or bins in the YAML pane.</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <fieldset className="client-card">
      <legend>Client {getStr(obj, [...base, 'id']) || `#${index}`}</legend>
      <button
        type="button"
        className="card-remove"
        onClick={onRemove}
        aria-label={`Remove client ${getStr(obj, [...base, 'id']) || `#${index}`}`}
        title="Remove client"
      >
        −
      </button>
      <div className="field-row">
        <div className="field">
          <label htmlFor={id('id')}>id</label>
          <input id={id('id')} {...b.str([...base, 'id'])} />
        </div>
        <div className="field">
          <label htmlFor={id('slo')}>slo_class</label>
          <Select
            id={id('slo')}
            value={getStr(obj, [...base, 'slo_class'])}
            onChange={(v) => onChange(setStr(obj, [...base, 'slo_class'], v))}
            options={SLO_CLASSES.map((c) => ({ value: c, label: c === '' ? '(unset)' : c }))}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label id={id('loadkind')}>load</label>
          {/* Two mutually exclusive shapes, so a segmented control shows both side by side
              rather than hiding one behind a dropdown. Switching drops the other field. */}
          <div className="seg" role="radiogroup" aria-labelledby={id('loadkind')}>
            {(['rate', 'concurrency'] as const).map((kind) => (
              <label key={kind} className={loadKind === kind ? 'on' : undefined}>
                <input
                  type="radio"
                  name={id('loadkind')}
                  value={kind}
                  checked={loadKind === kind}
                  onChange={() => switchLoad(kind)}
                />
                {kind === 'rate' ? 'rate_fraction' : 'concurrency'}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor={id('loadval')}>{loadKind === 'concurrency' ? 'concurrency' : 'rate_fraction'}</label>
          <input id={id('loadval')} type="number" {...b.num(loadPath)} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor={id('arrival')}>arrival.process</label>
          <Select
            id={id('arrival')}
            value={getStr(obj, [...base, 'arrival', 'process'])}
            onChange={(v) => onChange(setStr(obj, [...base, 'arrival', 'process'], v))}
            options={ARRIVAL_PROCESSES.map((p) => ({ value: p, label: p }))}
          />
        </div>
        <div className="field">
          <label htmlFor={id('cv')}>arrival.cv (optional)</label>
          <input id={id('cv')} type="number" {...b.num([...base, 'arrival', 'cv'])} />
        </div>
      </div>

      {distRow('input')}
      {distRow('output')}

      <div className="field-row">
        <div className="field">
          <label htmlFor={id('prefix')}>prefix_length</label>
          <input id={id('prefix')} type="number" {...b.num([...base, 'prefix_length'])} />
        </div>
        <div className="field">
          <label htmlFor={id('think')}>think_time_us (optional)</label>
          <input id={id('think')} type="number" {...b.num([...base, 'think_time_us'])} />
        </div>
        <div className="field">
          <label id={id('stream')}>streaming</label>
          {/* A boolean, shown in the same segmented vocabulary as the load control rather
              than a lone native checkbox. */}
          <div className="seg" role="radiogroup" aria-labelledby={id('stream')}>
            {([true, false] as const).map((on) => {
              const checked = getBool(obj, [...base, 'streaming']) === on
              return (
                <label key={String(on)} className={checked ? 'on' : undefined}>
                  <input
                    type="radio"
                    name={id('stream')}
                    checked={checked}
                    onChange={() => onChange(setBool(obj, [...base, 'streaming'], on))}
                  />
                  {on ? 'on' : 'off'}
                </label>
              )
            })}
          </div>
        </div>
      </div>

    </fieldset>
  )
}
