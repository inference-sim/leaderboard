import { describe, it, expect } from 'vitest'
import {
  interpret,
  initialForm,
  bodyToForm,
  profileSummary,
  profileKnobs,
  specText,
  variantOf,
  crossRef,
  listWorkloads,
  validateWorkload,
  saveWorkload,
  deleteWorkload,
  type FormValues,
  type ProfileBody,
} from './workloads'

function form(overrides: Partial<FormValues> = {}): FormValues {
  return { ...initialForm(), name: 'chat-6rps', ...overrides }
}

/** A flat distribution profile, the legacy variant the editor no longer authors but the
 * catalog still shows. */
function distBody(overrides: Partial<ProfileBody> = {}): ProfileBody {
  return {
    name: 'legacy',
    seed: 42,
    horizon_ticks: null,
    request_timeout_s: 300,
    workload: {
      type: 'distribution',
      num_requests: 500,
      load: { kind: 'rate', value: 6 },
      prompt_tokens: 512,
      prompt_tokens_stdev: 256,
      output_tokens: 128,
      output_tokens_stdev: 256,
    },
    ...overrides,
  }
}

describe('specText', () => {
  it('returns the WorkloadSpec YAML for a spec-backed profile', () => {
    const body = interpret(form()).body!
    expect(specText(body)).toContain('aggregate_rate')
  })

  it('falls back to serializing the spec object when no YAML text is present', () => {
    const body: ProfileBody = {
      ...distBody(),
      workload: { type: 'workload-spec', spec: { version: '2', aggregate_rate: 20 } },
    }
    expect(specText(body)).toContain('aggregate_rate: 20')
  })

  it('is null for a distribution profile, which has no spec', () => {
    expect(specText(distBody())).toBeNull()
  })
})

describe('profileKnobs', () => {
  it('names the seed, an uncapped horizon, and the timeout', () => {
    expect(profileKnobs(distBody())).toBe('seed 42 · no horizon cap · timeout 300s')
  })

  it('reports a set horizon in ticks', () => {
    expect(profileKnobs(distBody({ horizon_ticks: 100000 }))).toContain('horizon 100000 ticks')
  })

  it('says the timeout is disabled when negative', () => {
    expect(profileKnobs(distBody({ request_timeout_s: -1 }))).toContain('timeout disabled')
  })
})

describe('interpret', () => {
  it('builds a workload-spec body carrying the spec YAML from a valid form', () => {
    const { issues, body } = interpret(form())
    expect(issues).toEqual([])
    expect(body).not.toBeNull()
    expect(body!.workload.type).toBe('workload-spec')
    expect(body!.workload.spec_yaml).toBe(initialForm().specYaml)
    // The distribution shortcut fields do not travel in a spec body.
    expect(body!.workload.num_requests).toBeUndefined()
  })

  it('rejects an empty or malformed name', () => {
    expect(interpret(form({ name: '' })).issues.some((i) => i.field === 'name')).toBe(true)
    expect(interpret(form({ name: 'Has Spaces' })).issues.some((i) => i.field === 'name')).toBe(true)
    expect(interpret(form({ name: 'chat-6rps' })).issues.some((i) => i.field === 'name')).toBe(false)
  })

  it('rejects request_timeout_s of exactly zero', () => {
    expect(interpret(form({ requestTimeoutS: 0 })).issues.some((i) => i.field === 'requestTimeoutS')).toBe(true)
  })

  it('rejects a non-positive or non-integer horizon', () => {
    expect(interpret(form({ horizonTicks: 0 })).issues.some((i) => i.field === 'horizonTicks')).toBe(true)
    expect(interpret(form({ horizonTicks: null })).issues.some((i) => i.field === 'horizonTicks')).toBe(false)
  })

  it('rejects a spec that is not parseable YAML', () => {
    const { issues, body } = interpret(form({ specYaml: 'clients: [unterminated' }))
    expect(issues.some((i) => i.field === 'specYaml')).toBe(true)
    expect(body).toBeNull()
  })

  it('rejects an empty spec', () => {
    expect(interpret(form({ specYaml: '   ' })).issues.some((i) => i.field === 'specYaml')).toBe(true)
  })

  it('offers no body while any issue stands', () => {
    expect(interpret(form({ name: '' })).body).toBeNull()
  })
})

describe('bodyToForm', () => {
  it('round-trips a spec profile through the editor form', () => {
    const original = interpret(form({ seed: 7 })).body!
    const reinterpreted = interpret(bodyToForm(original)).body!
    expect(reinterpreted).toEqual(original)
  })

  it('opens a spec profile on its YAML', () => {
    const f = bodyToForm({
      name: 'cohort',
      seed: 1,
      horizon_ticks: null,
      request_timeout_s: 300,
      workload: { type: 'workload-spec', spec_yaml: 'version: "2"\n' },
    })
    expect(f.specYaml).toBe('version: "2"\n')
  })

  it('lifts a legacy distribution profile into an equivalent WorkloadSpec', () => {
    const f = bodyToForm({
      name: 'legacy',
      seed: 3,
      horizon_ticks: null,
      request_timeout_s: 300,
      workload: {
        type: 'distribution',
        num_requests: 500,
        load: { kind: 'rate', value: 6 },
        prompt_tokens: 512,
        prompt_tokens_stdev: 128,
        output_tokens: 128,
        output_tokens_stdev: 64,
      },
    })
    // The lifted spec is a runnable single-client WorkloadSpec, editable in the one editor.
    expect(f.specYaml).toContain('aggregate_rate: 6')
    expect(f.specYaml).toContain('num_requests: 500')
    expect(f.specYaml).toContain('rate_fraction: 1')
    expect(interpret(f).body!.workload.type).toBe('workload-spec')
  })
})

describe('variantOf', () => {
  it('is always workload-spec: the editor is spec-first', () => {
    expect(variantOf(form())).toBe('workload-spec')
  })
})

describe('profileSummary', () => {
  it('summarizes a spec profile by its aggregate rate', () => {
    const body = interpret(form()).body!
    expect(profileSummary(body)).toBe('spec-backed workload at 10 req/s aggregate')
  })

  it('names a rate-less spec simply spec-backed, inventing no numbers', () => {
    const body = interpret(form({ specYaml: 'version: "2"\ncohorts: []\n' })).body!
    expect(profileSummary(body)).toBe('spec-backed workload')
    expect(profileSummary(body)).not.toContain('requests at')
  })
})

describe('crossRef', () => {
  // Both variants are matched by workloadKey: a legacy distribution profile (as may still
  // sit in workloads.yaml) and a spec profile alike. A spec profile carries the spec and
  // its spec_sha256 the server emits, so profileToGroup rebuilds the same group the runs
  // declared from it were filed under — including the presets, which are spec-backed.
  const distributionBody: ProfileBody = {
    name: 'chat',
    seed: 42,
    horizon_ticks: null,
    request_timeout_s: 300,
    workload: {
      type: 'distribution',
      num_requests: 500,
      load: { kind: 'rate', value: 6 },
      prompt_tokens: 512,
      prompt_tokens_stdev: 256,
      output_tokens: 128,
      output_tokens_stdev: 256,
    },
  }

  // A spec profile as the server emits it: the full spec plus the spec_sha256 it hashed,
  // the shape a preset (chatbot) arrives in.
  const specBody: ProfileBody = {
    name: 'chatbot',
    seed: 42,
    horizon_ticks: null,
    request_timeout_s: 300,
    workload: {
      type: 'workload-spec',
      spec: { version: '2', aggregate_rate: 10, num_requests: 500, clients: [] },
      spec_sha256: 'e264541cc9716e6ac4950f2b825f297dbaae44d7523f0e3ed6652c60ad318762',
    },
  }

  it('counts models and runs under a matching workload, matched by workloadKey', () => {
    const fakeWorkloads = [
      { workloadKey: keyOf(distributionBody), models: ['a/x'], records: [1, 2, 3] },
    ] as unknown as Parameters<typeof crossRef>[1]
    expect(crossRef(distributionBody, fakeWorkloads)).toEqual({ models: 1, runs: 3 })
  })

  it('counts runs for a spec profile too, matched by its workloadKey', () => {
    const fakeWorkloads = [
      { workloadKey: keyOf(specBody), models: ['a/x', 'a/y'], records: [1, 2] },
    ] as unknown as Parameters<typeof crossRef>[1]
    expect(crossRef(specBody, fakeWorkloads)).toEqual({ models: 2, runs: 2 })
  })

  it('reports zero when no board workload matches the profile', () => {
    expect(crossRef(specBody, [])).toEqual({ models: 0, runs: 0 })
  })
})

// keyOf recomputes the profile's workloadKey the way crossRef does, so the fixture
// above lines up without hard-coding a hash.
import { workloadKey } from './load'
import { profileToGroup } from './workloads'
function keyOf(body: ProfileBody): string {
  return workloadKey(profileToGroup(body))
}

describe('api client', () => {
  const record = { ok: true } as unknown

  it('listWorkloads GETs the catalog', async () => {
    let seen: { url: string; method?: string } | null = null
    const fetchImpl = (async (url, init) => {
      seen = { url: String(url), method: init?.method }
      return new Response(JSON.stringify({ schema_version: 1, workloads: [] }), { status: 200 })
    }) as typeof fetch
    const got = await listWorkloads(fetchImpl)
    expect(seen!.url).toBe('/api/workloads')
    expect(got).toEqual([])
  })

  it('validateWorkload POSTs to the validate endpoint', async () => {
    let seen: { url: string; body: unknown } | null = null
    const fetchImpl = (async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response(
        JSON.stringify({ ok: true, variant: 'workload-spec', summary: 's', twin: null, issues: [] }),
        { status: 200 },
      )
    }) as typeof fetch
    const body = interpret(form()).body!
    const resp = await validateWorkload(body, fetchImpl)
    expect(seen!.url).toBe('/api/workloads/validate')
    expect(resp.variant).toBe('workload-spec')
  })

  it('saveWorkload POSTs on create and PUTs on rename', async () => {
    const calls: { url: string; method?: string }[] = []
    const fetchImpl = (async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(JSON.stringify(record), { status: 200 })
    }) as typeof fetch
    const body = interpret(form()).body!
    await saveWorkload(body, null, fetchImpl)
    await saveWorkload(body, 'old-name', fetchImpl)
    expect(calls[0]).toEqual({ url: '/api/workloads', method: 'POST' })
    expect(calls[1]).toEqual({ url: '/api/workloads/old-name', method: 'PUT' })
  })

  it('surfaces the server error message on a non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'a workload named "chat" already exists' }), {
        status: 409,
      })) as typeof fetch
    const body = interpret(form()).body!
    await expect(saveWorkload(body, null, fetchImpl)).rejects.toThrow(/already exists/)
  })

  it('deleteWorkload DELETEs by name', async () => {
    let seen: { url: string; method?: string } | null = null
    const fetchImpl = (async (url, init) => {
      seen = { url: String(url), method: init?.method }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await deleteWorkload('chat', fetchImpl)
    expect(seen).toEqual({ url: '/api/workloads/chat', method: 'DELETE' })
  })
})
