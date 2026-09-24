import { describe, it, expect } from 'vitest'
import {
  defaultSpec,
  newClient,
  appendClient,
  changeDistType,
  removeAt,
  parseSpec,
  serializeSpec,
  getStr,
  getNum,
  getBool,
  getPath,
  setStr,
  setNum,
  setBool,
  setPath,
  firstClientPath,
  summarizeSpec,
  singleClient,
  distTerms,
  type SpecObject,
} from './spec'

describe('parse / serialize', () => {
  it('round-trips the default spec through YAML', () => {
    const yaml = serializeSpec(defaultSpec())
    const { obj, error } = parseSpec(yaml)
    expect(error).toBeNull()
    expect(obj).toEqual(defaultSpec())
  })

  it('quotes version so it stays a string', () => {
    expect(serializeSpec({ version: '2' })).toContain('version: "2"')
  })

  it('reports a blank buffer, a YAML error, and a non-mapping top level', () => {
    expect(parseSpec('   ').error).toMatch(/empty/i)
    expect(parseSpec('clients: [oops').error).not.toBeNull()
    expect(parseSpec('- a\n- b').error).toMatch(/mapping/i)
  })
})

describe('path accessors', () => {
  const spec: SpecObject = {
    aggregate_rate: 10,
    category: 'language',
    clients: [{ id: 'c0', streaming: true, arrival: { process: 'poisson' } }],
  }

  it('reads strings, numbers and booleans by path, empty when absent', () => {
    expect(getStr(spec, ['category'])).toBe('language')
    expect(getNum(spec, ['aggregate_rate'])).toBe('10')
    expect(getBool(spec, ['clients', 0, 'streaming'])).toBe(true)
    expect(getStr(spec, ['clients', 0, 'slo_class'])).toBe('')
    expect(getNum(spec, ['nope'])).toBe('')
  })

  it('sets without mutating the source and creates intermediate objects', () => {
    const next = setNum(spec, ['clients', 0, 'input_distribution', 'params', 'mean'], '512')
    expect(getNum(next, ['clients', 0, 'input_distribution', 'params', 'mean'])).toBe('512')
    // The original is untouched.
    expect(getNum(spec, ['clients', 0, 'input_distribution', 'params', 'mean'])).toBe('')
  })

  it('drops a key when a value is cleared, so no empty strings reach the YAML', () => {
    const next = setStr(spec, ['category'], '')
    expect('category' in next).toBe(false)
  })

  it('ignores a half-typed number rather than clobbering the field', () => {
    const next = setNum(spec, ['aggregate_rate'], '-')
    expect(getNum(next, ['aggregate_rate'])).toBe('10')
  })

  it('writes booleans', () => {
    expect(getBool(setBool(spec, ['clients', 0, 'streaming'], false), ['clients', 0, 'streaming'])).toBe(false)
  })
})

describe('firstClientPath', () => {
  it('finds clients[0] when present and steps aside otherwise', () => {
    expect(firstClientPath({ clients: [{ id: 'c0' }] })).toEqual(['clients', 0])
    expect(firstClientPath({ cohorts: [{ id: 'web' }] })).toBeNull()
    expect(firstClientPath({ clients: [] })).toBeNull()
  })
})

describe('load switching preserves unrelated fields', () => {
  it('clears the other load key while keeping the rest of the client', () => {
    const base: SpecObject = { clients: [{ id: 'c0', rate_fraction: 1, streaming: true }] }
    const toConcurrency = setPath(setPath(base, ['clients', 0, 'rate_fraction'], undefined), ['clients', 0, 'concurrency'], 4)
    expect(getNum(toConcurrency, ['clients', 0, 'concurrency'])).toBe('4')
    expect('rate_fraction' in (toConcurrency.clients as SpecObject[])[0]!).toBe(false)
    expect(getBool(toConcurrency, ['clients', 0, 'streaming'])).toBe(true)
  })
})

describe('distributions carry blis-valid parameters', () => {
  it('defaults a client to gaussian with mean, std_dev, min and max', () => {
    const c = newClient('c0')
    const inParams = getPath(c, ['input_distribution', 'params']) as Record<string, unknown>
    expect(getStr(c, ['input_distribution', 'type'])).toBe('gaussian')
    expect(Object.keys(inParams).sort()).toEqual(['max', 'mean', 'min', 'std_dev'])
  })

  it('changeDistType swaps to the new type\'s required params, keeping shared ones', () => {
    // gaussian (the default) → lognormal (mu, sigma): no shared keys, all default.
    const ln = changeDistType(newClient('c0'), ['input_distribution'], 'lognormal')
    expect(getStr(ln, ['input_distribution', 'type'])).toBe('lognormal')
    expect(Object.keys(getPath(ln, ['input_distribution', 'params']) as object).sort()).toEqual(['mu', 'sigma'])
    // lognormal → gaussian keeps nothing stale: exactly mean, std_dev, min, max.
    const g = changeDistType(ln, ['input_distribution'], 'gaussian')
    expect(getStr(g, ['input_distribution', 'type'])).toBe('gaussian')
    expect(Object.keys(getPath(g, ['input_distribution', 'params']) as object).sort()).toEqual([
      'max',
      'mean',
      'min',
      'std_dev',
    ])
  })

  it('changeDistType preserves a shared parameter value', () => {
    // lognormal → pareto_lognormal shares mu and sigma; their values carry over.
    const ln = changeDistType(newClient('c0'), ['input_distribution'], 'lognormal')
    const c = setNum(ln, ['input_distribution', 'params', 'mu'], '7.1')
    const p = changeDistType(c, ['input_distribution'], 'pareto_lognormal')
    expect(getNum(p, ['input_distribution', 'params', 'mu'])).toBe('7.1')
  })
})

describe('clients as a list', () => {
  it('appends a client at the end of clients[] with a non-colliding id', () => {
    const next = appendClient(defaultSpec())
    const clients = getPath(next, ['clients']) as SpecObject[]
    expect(clients).toHaveLength(2)
    expect(getStr(next, ['clients', 1, 'id'])).toBe('c1')
    // The first client is untouched.
    expect(getStr(next, ['clients', 0, 'id'])).toBe('c0')
  })

  it('removes a client by index without disturbing the others', () => {
    const two = setPath(defaultSpec(), ['clients', 1], newClient('c1'))
    const next = removeAt(two, ['clients'], 0)
    const clients = getPath(next, ['clients']) as SpecObject[]
    expect(clients).toHaveLength(1)
    expect(getStr(next, ['clients', 0, 'id'])).toBe('c1')
  })
})

describe('summarizeSpec', () => {
  it('names a spec by its positive aggregate rate, else spec-backed', () => {
    expect(summarizeSpec({ aggregate_rate: 10 })).toBe('spec-backed workload at 10 req/s aggregate')
    expect(summarizeSpec({ aggregate_rate: 0 })).toBe('spec-backed workload')
    expect(summarizeSpec(null)).toBe('spec-backed workload')
  })
})

describe('singleClient', () => {
  it('returns the sole client of a one-client spec', () => {
    const spec = { clients: [{ id: 'c0' }] }
    expect(singleClient(spec)).toEqual({ id: 'c0' })
  })

  it('returns null for a multi-client, cohort, or clientless spec (the flat grid cannot describe it)', () => {
    expect(singleClient({ clients: [{ id: 'c0' }, { id: 'c1' }] })).toBeNull()
    expect(singleClient({ cohorts: [{ id: 'a' }], clients: [{ id: 'c0' }] })).toBeNull()
    expect(singleClient({ aggregate_rate: 10 })).toBeNull()
    expect(singleClient(null)).toBeNull()
  })
})

describe('distTerms', () => {
  it('renders a gaussian as "mean ±std" with its clamp as detail', () => {
    expect(distTerms({ type: 'gaussian', params: { mean: 256, std_dev: 100, min: 2, max: 800 } })).toEqual({
      text: '256 ±100',
      detail: '[2–800]',
    })
  })

  it('renders another family by its name with its parameters as detail', () => {
    expect(distTerms({ type: 'lognormal', params: { mu: 6.2, sigma: 0.5 } })).toEqual({
      text: 'lognormal',
      detail: 'mu 6.2, sigma 0.5',
    })
  })

  it('degrades to a placeholder when there is no distribution', () => {
    expect(distTerms(null)).toEqual({ text: 'in spec' })
  })
})
