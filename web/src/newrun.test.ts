import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import argvRecords from '../../prototypes/argv-records.json'
import { loadGroups } from './load'
import type { RunRecord } from './load'
import {
  RUN_ID_PATTERN,
  argvFor,
  arrivalProcess,
  canonical,
  customFieldsFrom,
  initialValues,
  interpret,
  postRun,
  saveThenRun,
  suggestRunId,
  yamlRow,
} from './newrun'
import type { FormValues } from './newrun'
import type { ProfileBody } from './workloads'
import { MODELS } from './catalog'

const groups = loadGroups(fixture as unknown as RunRecord[])
const main = groups.find((g) => g.groupId === '5063e40dceb2')!

/**
 * A custom-workload form that lands a new H100 tp8 row in the fixture's main group.
 * initialValues opens in custom mode seeded from FALLBACK_GROUP, which is the same work
 * as the main group, so an untouched custom form joins it. A custom workload is saved to
 * the catalog on Run, so the form carries a name; the helper supplies a valid one that
 * clashes with none of the test profiles.
 */
function valid(overrides: Partial<FormValues> = {}): FormValues {
  return { ...initialValues(), runId: 'h100-tp8', tp: '8', customName: 'custom-run', ...overrides }
}

/** A distribution profile whose work is exactly the main group's, so selecting it plus
 * the main group's model joins that table. Built from the fixture so it cannot drift. */
function mainClone(): ProfileBody {
  const w = main.group.workload
  return {
    name: 'main-clone',
    seed: main.group.seed,
    horizon_ticks: main.group.horizon_ticks,
    request_timeout_s: main.group.request_timeout_s,
    workload: {
      type: 'distribution',
      num_requests: w.num_requests,
      load: w.load,
      prompt_tokens: w.prompt_tokens,
      prompt_tokens_stdev: w.prompt_tokens_stdev,
      output_tokens: w.output_tokens,
      output_tokens_stdev: w.output_tokens_stdev,
    },
  }
}

/** A spec-backed profile, the variant the custom card cannot represent. */
function specProfile(overrides: Partial<ProfileBody> = {}): ProfileBody {
  return {
    name: 'burst',
    seed: 7,
    horizon_ticks: null,
    request_timeout_s: 300,
    workload: {
      type: 'workload-spec',
      spec_sha256: 'deadbeef',
      spec_yaml: 'version: "2"\naggregate_rate: 20\nnum_requests: 100\n',
      spec: { version: '2', aggregate_rate: 20, num_requests: 100 },
    },
    ...overrides,
  }
}

/**
 * A committed set of real records the Go builder wrote, curated to cover every argv
 * shape: distribution and workload-spec workloads, open-loop --rate and closed-loop
 * --concurrency, across a range of tp. This is the pin between argvFor and
 * internal/blisrun.Argv: reproducing each stored argv means the two agree about flag
 * order, the omitted --dp, and the rest.
 *
 * The fixture is committed (unlike results/, which is gitignored generated output) so
 * the pin runs on a clean checkout in CI, not just on a machine with local runs. The
 * metrics path and the materialized --workload-spec path are pass-through inputs to
 * argvFor, so they were normalized to stable placeholders when the fixture was built;
 * every other flag is exactly as Go emitted it.
 */
const committed = (argvRecords as unknown as RunRecord[]).map((record, i) => ({
  path: `prototypes/argv-records.json[${i}]`,
  record,
}))

describe('argvFor', () => {
  it('reproduces the stored argv of every committed record', () => {
    expect(committed.length).toBeGreaterThan(0)
    for (const { path, record } of committed) {
      const stored = record.provenance.argv
      const metricsPath = stored[stored.length - 1]!
      // A spec record's argv carries the materialized --workload-spec path; feed it the
      // same one Go used, so this pins the spec branch as tightly as the distribution one.
      const specIdx = stored.indexOf('--workload-spec')
      const specPath = specIdx >= 0 ? stored[specIdx + 1]! : ''
      expect(
        argvFor(stored[0]!, record.group, record.deployment, metricsPath, specPath),
        path,
      ).toEqual(stored)
    }
  })

  it('passes --concurrency instead of --rate in closed-loop mode, never both', () => {
    const group = {
      ...main.group,
      workload: { ...main.group.workload, load: { kind: 'concurrency' as const, value: 32 } },
    }
    const argv = argvFor('./blis', group, main.records[0]!.deployment, '/tmp/x.json')
    expect(argv).toContain('--concurrency')
    expect(argv).not.toContain('--rate')
    expect(argv[argv.indexOf('--concurrency') + 1]).toBe('32')
  })

  it('omits --max-model-len when it is unset, since 0 means blis derives it', () => {
    const deployment = { ...main.records[0]!.deployment, max_model_len: 0 }
    expect(argvFor('./blis', main.group, deployment, '/tmp/x.json')).not.toContain('--max-model-len')
  })

  it('emits --workload-spec and omits the synthetic flags for a spec group (Go Argv branch)', () => {
    const group = interpret(valid({ workloadSel: 'burst' }), groups, [specProfile()]).output!.group
    const argv = argvFor('./blis', group, main.records[0]!.deployment, '/tmp/x.json', '/tmp/spec.yaml')
    expect(argv).toContain('--workload-spec')
    expect(argv[argv.indexOf('--workload-spec') + 1]).toBe('/tmp/spec.yaml')
    // The distribution surface is superseded by the spec file (upstream: --workload-spec
    // overrides --workload, and the synthetic flags are read only on the synthesize path).
    expect(argv).not.toContain('--workload')
    expect(argv).not.toContain('--rate')
    expect(argv).not.toContain('--prompt-tokens')
    expect(argv).not.toContain('--num-requests')
    // Group-side knobs are passed in both variants.
    expect(argv).toContain('--seed')
    expect(argv[argv.indexOf('--seed') + 1]).toBe('7')
    expect(argv).toContain('--timeout')
  })
})

describe('suggestRunId: a descriptive default, so the page is immediately runnable', () => {
  it('names the candidate <hardware>-tp<tp>, lower-cased to a usable filename', () => {
    expect(suggestRunId(valid({ hardware: 'H100', tp: '8' }), [], [])).toBe('h100-tp8')
    // Hardware names carry upper case and dashes; both survive as a valid run_id/filename.
    expect(suggestRunId(valid({ hardware: 'A100-SXM', tp: '1' }), [], [])).toBe('a100-sxm-tp1')
    expect(RUN_ID_PATTERN.test(suggestRunId(valid({ hardware: 'A100-SXM', tp: '1' }), [], []))).toBe(true)
  })

  it('deduplicates against the table it would join, so the default never overwrites a row', () => {
    // The main group already holds h100-tp1. This candidate is H100 tp1 too (so its base id
    // collides) but differs in a knob (so it is not a twin), which is exactly the case the
    // suffix is for: a runnable id that does not overwrite the existing row.
    const v = valid({ tp: '1', maxNumSeqs: '8' })
    expect(
      interpret({ ...v, runId: 'h100-tp1' }, groups, []).issues.some((i) => /already holds/.test(i.message)),
    ).toBe(true)
    const suggested = suggestRunId(v, groups, [])
    expect(suggested).toMatch(/^h100-tp1-\d+$/)
    expect(interpret({ ...v, runId: suggested }, groups, []).output).not.toBeNull()
  })

  it('is stable: re-suggesting from a form that already holds the suggestion is a fixed point', () => {
    const v = valid({ tp: '1', maxNumSeqs: '8' })
    const once = suggestRunId(v, groups, [])
    expect(suggestRunId({ ...v, runId: once }, groups, [])).toBe(once)
  })
})

describe('initialValues: opens with a descriptive run id, not a blank field', () => {
  it('seeds a valid, non-empty id from the default candidate', () => {
    expect(initialValues().runId).toBe('h100-tp1')
    expect(RUN_ID_PATTERN.test(initialValues().runId)).toBe(true)
  })
})

describe('arrivalProcess', () => {
  it('is derived from the load kind, never authored', () => {
    expect(arrivalProcess('rate')).toBe('constant')
    expect(arrivalProcess('concurrency')).toBe('closed-loop')
  })
})

describe('interpret: a selected profile', () => {
  it('joins the existing table when a chosen workload canonically matches a board group', () => {
    const values = valid({ workloadSel: 'main-clone', model: 'qwen/qwen3-14b' })
    const { issues, output } = interpret(values, groups, [mainClone()])
    expect(issues).toEqual([])
    expect(output?.target.group?.groupId).toBe('5063e40dceb2')
    expect(output?.resultPath).toBe('results/5063e40dceb2/h100-tp8.json')
  })

  it('carries a distribution profile’s work into the group and the chosen model onto the candidate', () => {
    // A different model against the same work now JOINS the table (E1): model left the key.
    const values = valid({ workloadSel: 'main-clone', model: '01-ai/yi-34b' })
    const { output } = interpret(values, groups, [mainClone()])
    expect(output?.deployment.model).toBe('01-ai/yi-34b')
    expect(output?.group.workload.type).toBe('distribution')
    expect(output?.group.workload.num_requests).toBe(main.group.workload.num_requests)
    expect(output?.target.group?.groupId).toBe('5063e40dceb2')
  })

  it('carries a spec profile’s spec and spec_sha256 into the group, model onto the candidate', () => {
    const { output } = interpret(valid({ workloadSel: 'burst' }), groups, [specProfile()])
    expect(output?.group.workload.type).toBe('workload-spec')
    expect(output?.group.workload.spec_sha256).toBe('deadbeef')
    expect((output?.group.workload as { spec?: unknown }).spec).toEqual({
      version: '2',
      aggregate_rate: 20,
      num_requests: 100,
    })
    expect(output?.deployment.model).toBe('qwen/qwen3-14b')
  })

  it('flags a workload that is no longer in the catalog', () => {
    const { issues, output } = interpret(valid({ workloadSel: 'gone' }), groups, [mainClone()])
    expect(issues.map((i) => i.message).join(' ')).toMatch(/no longer in the catalog/)
    expect(output).toBeNull()
  })
})

describe('interpret: the custom card', () => {
  it('builds a distribution group from the card fields', () => {
    const { output } = interpret(valid(), groups, [])
    expect(output?.group.workload.type).toBe('distribution')
    expect(output?.target.group?.groupId).toBe('5063e40dceb2')
  })

  it('makes tokens, seed and deadline editable — each changes the group it would hash', () => {
    const base = interpret(valid(), groups, []).output!.group
    const withTokens = interpret(valid({ promptTokens: '1024' }), groups, []).output!.group
    expect(withTokens.workload.prompt_tokens).toBe(1024)
    expect(canonical(withTokens)).not.toBe(canonical(base))

    const withSeed = interpret(valid({ seed: '99' }), groups, []).output!.group
    expect(withSeed.seed).toBe(99)
    expect(canonical(withSeed)).not.toBe(canonical(base))

    const withDeadline = interpret(valid({ requestTimeoutS: '120' }), groups, []).output!.group
    expect(withDeadline.request_timeout_s).toBe(120)
    expect(canonical(withDeadline)).not.toBe(canonical(base))
  })

  it('carries the derived arrival process into the group it would hash', () => {
    const { output } = interpret(valid({ loadKind: 'concurrency', loadValue: '32' }), groups, [])
    expect(output?.group.workload.arrival_process).toBe('closed-loop')
    expect(output?.target.group).toBeNull()
  })
})

describe('interpret: a custom workload is saved to the catalog', () => {
  it('offers the custom distribution as a new distribution profile, saved under the given name', () => {
    const { output, issues, notes } = interpret(valid({ customName: 'my-load' }), groups, [])
    expect(issues).toEqual([])
    expect(notes).toEqual([])
    expect(output?.workloadName).toBe('my-load')
    expect(output?.saveProfile?.name).toBe('my-load')
    expect(output?.saveProfile?.workload.type).toBe('distribution')
    // The saved profile is exactly the work the run declares, so it hashes to the same table.
    expect(output?.saveProfile?.workload.num_requests).toBe(output?.group.workload.num_requests)
    expect(output?.saveProfile?.seed).toBe(output?.group.seed)
    expect(output?.saveProfile?.request_timeout_s).toBe(output?.group.request_timeout_s)
  })

  it('requires a name, since the workload is saved for reuse', () => {
    const { output, issues } = interpret(valid({ customName: '' }), groups, [])
    expect(output).toBeNull()
    expect(issues.some((i) => i.field === 'customName' && /needs a name/.test(i.message))).toBe(true)
  })

  it('rejects a name that is not a usable catalog slug', () => {
    const { issues } = interpret(valid({ customName: 'My Load' }), groups, [])
    expect(issues.some((i) => i.field === 'customName' && /lower-case/.test(i.message))).toBe(true)
  })

  it('reuses a content twin under a different name rather than saving a duplicate, and warns', () => {
    // The untouched custom card is the same work as main-clone (both are the main group),
    // so it twins that saved profile: P3 forbids a second name for one workload.
    const { output, notes } = interpret(valid({ customName: 'fresh-name' }), groups, [mainClone()])
    expect(output).not.toBeNull()
    expect(output?.saveProfile).toBeNull()
    expect(output?.workloadName).toBe('main-clone')
    expect(notes.join(' ')).toMatch(/main-clone/)
  })

  it('saves nothing when the same name already holds this exact work', () => {
    const { output, notes } = interpret(valid({ customName: 'main-clone' }), groups, [mainClone()])
    expect(output?.saveProfile).toBeNull()
    expect(output?.workloadName).toBe('main-clone')
    expect(notes.join(' ')).toMatch(/main-clone/)
  })

  it('blocks a name already taken by a workload with different content', () => {
    // "burst" names a spec profile whose content differs from this custom distribution.
    const { output, issues } = interpret(valid({ customName: 'burst' }), groups, [specProfile()])
    expect(output).toBeNull()
    expect(issues.some((i) => i.field === 'customName' && /already exists/.test(i.message))).toBe(true)
  })

  it('a selected catalog workload saves nothing and names the chosen profile', () => {
    const { output } = interpret(
      valid({ workloadSel: 'main-clone', model: 'qwen/qwen3-14b' }),
      groups,
      [mainClone()],
    )
    expect(output?.saveProfile).toBeNull()
    expect(output?.workloadName).toBe('main-clone')
  })
})

describe('saveThenRun: a custom workload is persisted, then run', () => {
  const custom = interpret(valid({ customName: 'my-load' }), groups, []).output!
  const chosen = interpret(
    valid({ workloadSel: 'main-clone', model: 'qwen/qwen3-14b' }),
    groups,
    [mainClone()],
  ).output!

  it('creates the new profile, then runs it', async () => {
    const calls: string[] = []
    const save = (async (body: ProfileBody, orig: string | null) => {
      calls.push(`save:${body.name}:${orig}`)
      return body
    }) as typeof import('./workloads').saveWorkload
    const post = (async () => {
      calls.push('post')
      return { run_id: 'r', group_id: 'g' } as unknown as RunRecord
    }) as typeof postRun
    const rec = await saveThenRun(custom, { save, post })
    expect(calls).toEqual(['save:my-load:null', 'post'])
    expect(rec).toEqual({ run_id: 'r', group_id: 'g' })
  })

  it('does not save when there is nothing to save (a chosen or reused workload)', async () => {
    const calls: string[] = []
    const save = (async () => {
      calls.push('save')
      return {} as ProfileBody
    }) as typeof import('./workloads').saveWorkload
    const post = (async () => {
      calls.push('post')
      return { run_id: 'r', group_id: 'g' } as unknown as RunRecord
    }) as typeof postRun
    await saveThenRun(chosen, { save, post })
    expect(calls).toEqual(['post'])
  })

  it('does not run if the save fails', async () => {
    let posted = false
    const save = (async () => {
      throw new Error('a workload named "my-load" already exists')
    }) as typeof import('./workloads').saveWorkload
    const post = (async () => {
      posted = true
      return {} as unknown as RunRecord
    }) as typeof postRun
    await expect(saveThenRun(custom, { save, post })).rejects.toThrow(/already exists/)
    expect(posted).toBe(false)
  })
})

describe('customFieldsFrom: switching to Custom prefills the card', () => {
  it('prefills from a distribution profile', () => {
    const f = customFieldsFrom(mainClone())
    expect(f.numRequests).toBe(String(main.group.workload.num_requests))
    expect(f.promptTokens).toBe(String(main.group.workload.prompt_tokens))
    expect(f.seed).toBe(String(main.group.seed))
    expect(f.loadValue).toBe(String(main.group.workload.load.value))
  })

  it('prefills from the flat fallback for a spec profile (the card cannot hold a spec)', () => {
    const f = customFieldsFrom(specProfile())
    expect(f.promptTokens).toBe('512')
    expect(f.seed).toBe('42')
    expect(f.numRequests).toBe('500')
  })

  it('prefills from the flat fallback on a fresh page (no profile)', () => {
    expect(customFieldsFrom(null).promptTokens).toBe('512')
  })
})

describe('interpret: refusals', () => {
  const messages = (values: FormValues, profiles: ProfileBody[] = []) =>
    interpret(values, groups, profiles).issues.map((i) => i.message)

  it('rejects a run_id that is not a usable filename', () => {
    expect(messages(valid({ runId: 'H100 TP8' })).join(' ')).toMatch(/lower-case/)
    expect(interpret(valid({ runId: 'H100 TP8' }), groups, []).output).toBeNull()
  })

  it('rejects a run_id the target table already holds, naming the overwrite', () => {
    expect(messages(valid({ runId: 'h100-tp1', tp: '8' })).join(' ')).toMatch(/already holds/)
  })

  it('rejects a deployment identical to a row that already exists', () => {
    // Untouched knobs sit at blis defaults, which is exactly h100-tp2's deployment once
    // tp is 2 — so this new row would differ from it in nothing.
    const clash = messages(valid({ runId: 'h100-tp2-again', tp: '2' })).join(' ')
    expect(clash).toMatch(/same deployment as h100-tp2\b/)
    expect(clash).toMatch(/differ invisibly/)
  })

  it('rejects an alias of hardware already in the table, since it is a duplicate row', () => {
    // The fixture has a100-tp1 on A100-SXM; A100-80 is the same specs upstream.
    const clash = messages(valid({ runId: 'a100-80-tp1', hardware: 'A100-80', tp: '1' })).join(' ')
    expect(clash).toMatch(/identical specs/)
  })

  it('rejects hardware that is not in the upstream catalogue', () => {
    expect(messages(valid({ hardware: 'B200' })).join(' ')).toMatch(/hardware_config\.json/)
  })

  it('rejects a model that is not in the upstream catalogue', () => {
    expect(messages(valid({ model: 'gpt-4' })).join(' ')).toMatch(/model_configs\//)
    expect(interpret(valid({ model: 'gpt-4' }), groups, []).output).toBeNull()
  })

  it('rejects non-positive load and request counts in the custom card', () => {
    expect(messages(valid({ loadValue: '0' })).join(' ')).toMatch(/positive/)
    expect(messages(valid({ numRequests: '2.5' })).join(' ')).toMatch(/whole number/)
    expect(messages(valid({ tp: '0' })).join(' ')).toMatch(/whole number/)
  })

  it('rejects a custom deadline of 0, which blis refuses', () => {
    expect(messages(valid({ requestTimeoutS: '0' })).join(' ')).toMatch(/0 is rejected by blis/)
  })

  it('rejects serving knobs blis would refuse: a 0 block size, a fractional dp', () => {
    expect(messages(valid({ blockSize: '0' })).join(' ')).toMatch(/KV block size/)
    expect(messages(valid({ maxNumSeqs: '0' })).join(' ')).toMatch(/Max sequences/)
    expect(messages(valid({ dp: '1.5' })).join(' ')).toMatch(/Data parallelism/)
    // max-model-len 0 is legal — it tells blis to derive the length — so it is not rejected.
    expect(messages(valid({ maxModelLen: '0' }))).toEqual([])
  })
})

describe('interpret: the candidate serving knobs', () => {
  it('carries each knob into the deployment it declares', () => {
    const values = valid({
      dp: '2',
      numInstances: '3',
      maxModelLen: '2048',
      blockSize: '32',
      maxNumSeqs: '128',
      maxNumBatchedTokens: '4096',
      scheduler: 'sjf',
      preemptionPolicy: 'priority',
      routingPolicy: 'least-loaded',
      admissionPolicy: 'token-bucket',
      kvCacheDtype: 'fp8',
      latencyModel: 'roofline',
      runId: 'h100-tuned',
    })
    const d = interpret(values, groups, []).output!.deployment
    expect(d).toMatchObject({
      dp: 2,
      num_instances: 3,
      max_model_len: 2048,
      block_size_in_tokens: 32,
      max_num_seqs: 128,
      max_num_batched_tokens: 4096,
      scheduler: 'sjf',
      preemption_policy: 'priority',
      routing_policy: 'least-loaded',
      admission_policy: 'token-bucket',
      kv_cache_dtype: 'fp8',
      latency_model: 'roofline',
    })
  })

  it('leaves the group_id untouched — a serving knob is a new row, not a new table', () => {
    const base = interpret(valid(), groups, []).output!
    const tuned = interpret(valid({ scheduler: 'sjf', runId: 'h100-tp8-sjf' }), groups, []).output!
    expect(canonical(tuned.group)).toBe(canonical(base.group))
    expect(tuned.target.group?.groupId).toBe(base.target.group?.groupId)
  })

  it('reaches the blis argv, so a changed knob actually changes the run', () => {
    const out = interpret(valid({ scheduler: 'sjf', runId: 'h100-tp8-sjf' }), groups, []).output!
    expect(out.argv[out.argv.indexOf('--scheduler') + 1]).toBe('sjf')
  })
})

describe('interpret: weighted routing scorers', () => {
  const weighted = (scorers: { name: string; weight: string }[], over = {}) =>
    valid({ routingPolicy: 'weighted', routingScorers: scorers, runId: 'h100-tp8-weighted', ...over })

  it('spells the profile out on the deployment and the argv, in order', () => {
    const out = interpret(
      weighted([
        { name: 'precise-prefix-cache', weight: '2' },
        { name: 'queue-depth', weight: '1' },
        { name: 'kv-utilization', weight: '1.5' },
      ]),
      groups,
      [],
    ).output!
    expect(out.deployment.routing_scorers).toEqual([
      { name: 'precise-prefix-cache', weight: 2 },
      { name: 'queue-depth', weight: 1 },
      { name: 'kv-utilization', weight: 1.5 },
    ])
    expect(out.argv[out.argv.indexOf('--routing-scorers') + 1]).toBe(
      'precise-prefix-cache:2,queue-depth:1,kv-utilization:1.5',
    )
    // It sits with the routing policy, before admission — mirrors internal/blisrun.Argv.
    expect(out.argv.indexOf('--routing-scorers')).toBeLessThan(out.argv.indexOf('--admission-policy'))
    // And it is spelled out in the declaration, as inline-flow YAML the loader accepts.
    expect(out.yamlFile).toContain(
      'routing_scorers: [{name: precise-prefix-cache, weight: 2}, {name: queue-depth, weight: 1}, {name: kv-utilization, weight: 1.5}]',
    )
  })

  it('omits the profile entirely for a non-weighted policy, even if scorers linger', () => {
    // round-robin carries the scorer state but declares no profile: blis would ignore and
    // warn about --routing-scorers otherwise, and the field must stay off the record.
    const out = interpret(
      valid({ routingPolicy: 'round-robin', routingScorers: [{ name: 'queue-depth', weight: '1' }] }),
      groups,
      [],
    ).output!
    expect(out.deployment.routing_scorers).toBeUndefined()
    expect(out.argv).not.toContain('--routing-scorers')
    // A non-weighted candidate is canonically identical to one that never touched routing,
    // so it joins the same table rather than reading as a distinct deployment.
    const plain = interpret(valid(), groups, []).output!
    expect(canonical(out.deployment)).toBe(canonical(plain.deployment))
  })

  it('rejects weighted routing with an empty profile — the record could not reproduce it', () => {
    const { issues, output } = interpret(weighted([]), groups, [])
    expect(output).toBeNull()
    expect(issues.some((i) => i.field === 'routingScorers' && /at least one scorer/.test(i.message))).toBe(true)
  })

  it('rejects a non-positive weight', () => {
    const { issues, output } = interpret(
      weighted([{ name: 'queue-depth', weight: '0' }]),
      groups,
      [],
    )
    expect(output).toBeNull()
    expect(issues.some((i) => i.field === 'routingScorers' && /greater than 0/.test(i.message))).toBe(true)
  })
})

describe('interpret: MoE knobs', () => {
  const moe = 'mistralai/mixtral-8x7b-v0.1' // a catalog MoE model
  it('emits the MoE flags for a MoE model on trained-physics', () => {
    const out = interpret(
      valid({ model: moe, enableExpertParallel: true, moeCommBackend: 'pplx', runId: 'moe' }),
      groups,
      [],
    ).output!
    expect(out.deployment.enable_expert_parallel).toBe(true)
    expect(out.deployment.moe_comm_backend).toBe('pplx')
    // --enable-expert-parallel is valueless; --moe-comm-backend carries its value.
    expect(out.argv).toContain('--enable-expert-parallel')
    expect(out.argv[out.argv.indexOf('--moe-comm-backend') + 1]).toBe('pplx')
    // Both sit before --num-instances.
    expect(out.argv.indexOf('--enable-expert-parallel')).toBeLessThan(out.argv.indexOf('--num-instances'))
  })

  it('omits the MoE flags when off, leaving a dense candidate unchanged', () => {
    const out = interpret(valid({ model: moe, runId: 'plain' }), groups, []).output!
    expect(out.deployment.enable_expert_parallel).toBeUndefined()
    expect(out.deployment.moe_comm_backend).toBeUndefined()
    expect(out.argv).not.toContain('--enable-expert-parallel')
    expect(out.argv).not.toContain('--moe-comm-backend')
  })

  it('rejects expert parallelism on a dense model', () => {
    const { issues, output } = interpret(
      valid({ model: 'qwen/qwen3-14b', enableExpertParallel: true }),
      groups,
      [],
    )
    expect(output).toBeNull()
    expect(issues.some((i) => i.field === 'enableExpertParallel' && /dense/.test(i.message))).toBe(true)
  })

  it('rejects a MoE backend without dp>1 or expert parallelism', () => {
    const { issues } = interpret(valid({ model: moe, moeCommBackend: 'pplx' }), groups, [])
    expect(issues.some((i) => i.field === 'moeCommBackend' && /dp > 1 or expert/.test(i.message))).toBe(true)
  })
})

describe('interpret: prefill/decode disaggregation', () => {
  const pd = (over = {}) => valid({ numInstances: '4', runId: 'pd', ...over })

  it('writes the disaggregation block and argv for a prefill/decode split', () => {
    const out = interpret(
      pd({ prefillInstances: '1', decodeInstances: '1', pdDecider: 'always' }),
      groups,
      [],
    ).output!
    expect(out.deployment.disaggregation).toMatchObject({
      prefill_instances: 1,
      decode_instances: 1,
      decider: 'always',
    })
    expect(out.argv).toContain('--prefill-instances')
    expect(out.argv[out.argv.indexOf('--pd-decider') + 1]).toBe('always')
    // Transfer physics at defaults are omitted from the argv.
    expect(out.argv).not.toContain('--pd-transfer-bandwidth')
    // The declaration spells the block out as inline-flow YAML.
    expect(out.yamlFile).toContain('disaggregation: {prefill_instances: 1, decode_instances: 1')
  })

  it('omits disaggregation entirely when no pool is set', () => {
    const out = interpret(pd(), groups, []).output!
    expect(out.deployment.disaggregation).toBeUndefined()
    expect(out.argv).not.toContain('--prefill-instances')
    // Canonically identical to a candidate that never touched PD.
    const plain = interpret(valid(), groups, []).output!
    expect(canonical(out.deployment)).toBe(canonical({ ...plain.deployment, num_instances: 4 }))
  })

  it('rejects a pool total that exceeds the cluster', () => {
    const { issues, output } = interpret(
      pd({ numInstances: '2', prefillInstances: '2', decodeInstances: '2' }),
      groups,
      [],
    )
    expect(output).toBeNull()
    expect(issues.some((i) => /more than the 2 in the cluster/.test(i.message))).toBe(true)
  })

  it('rejects prefill without decode unless the shared pool is used', () => {
    const { issues, output } = interpret(pd({ prefillInstances: '1' }), groups, [])
    expect(output).toBeNull()
    expect(issues.some((i) => /both a prefill and a decode pool/.test(i.message))).toBe(true)
    // The shared-role pool alone is allowed.
    expect(interpret(pd({ prefillDecodeInstances: '2' }), groups, []).output).not.toBeNull()
  })

  it('emits the prefix threshold only for the prefix-threshold decider', () => {
    const out = interpret(
      pd({ prefillDecodeInstances: '2', pdDecider: 'prefix-threshold', pdPrefixThreshold: '128' }),
      groups,
      [],
    ).output!
    expect(out.argv[out.argv.indexOf('--pd-prefix-threshold') + 1]).toBe('128')
    const always = interpret(pd({ prefillDecodeInstances: '2', pdDecider: 'always' }), groups, []).output!
    expect(always.argv).not.toContain('--pd-prefix-threshold')
  })
})

describe('interpret: the declaration it writes', () => {
  const output = interpret(valid(), groups, []).output!

  it('writes a runnable runs.yaml holding the group, the flags in full, and the row', () => {
    expect(output.yamlFile).toContain('schema_version: 1')
    expect(output.yamlFile).toContain('model: qwen/qwen3-14b')
    expect(output.yamlFile).toContain('      value: 6')
    expect(output.yamlFile).toContain('max_num_batched_tokens: 8192')
    expect(output.yamlFile).toContain('- {run_id: h100-tp8, hardware: H100, tp: 8}')
    // arrival_process is derived by the CLI, so authoring it would be rejected.
    expect(output.yamlFile).not.toContain('arrival_process')
  })

  it('spells out any flag the candidate sets away from the table it joins', () => {
    const values = valid({ maxNumSeqs: '8', runId: 'h100-tp8-seqs8' })
    const withCap = interpret(values, groups, []).output!
    expect(withCap.deployment.max_num_seqs).toBe(8)
    // The row is emitted against the table's first run, whose cap is 256, so the
    // candidate's changed cap is spelled out rather than left to inherit.
    expect(yamlRow(withCap.deployment, main.records[0]!.deployment, 'h100-tp8-seqs8')).toContain(
      'max_num_seqs: 8',
    )
  })

  it('writes the inline spec for a spec workload, and does not claim leaderboard run can consume it', () => {
    const out = interpret(valid({ workloadSel: 'burst' }), groups, [specProfile()]).output!
    expect(out.yamlFile).toContain('type: workload-spec')
    expect(out.yamlFile).toContain('aggregate_rate: 20')
    // The CLI runs.yaml path (internal/spec.Load) rejects a workload-spec, so the file
    // is not offered as a `leaderboard run` input.
    expect(out.yamlFile).not.toContain('leaderboard run -runs')
  })
})

describe('postRun', () => {
  const output = interpret(valid(), groups, []).output!

  it('POSTs the group, deployment and run_id, and returns the record on success', async () => {
    let seen: { url: string; body: unknown } | null = null
    const record = { run_id: 'h100-tp8', group_id: '5063e40dceb2' }
    const fakeFetch = (async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify(record), { status: 200 })
    }) as typeof fetch

    const got = await postRun(output, fakeFetch)
    expect(got).toEqual(record)
    expect(seen!.url).toBe('/api/run')
    expect(seen!.body).toEqual({
      group: output.group,
      deployment: output.deployment,
      run_id: 'h100-tp8',
      // A custom workload is saved to the catalog, so the record names the profile it
      // was saved under.
      workload_name: 'custom-run',
    })
  })

  it('sends the profile name as workload_name when a catalog workload is chosen', async () => {
    const out = interpret(valid({ workloadSel: 'burst' }), groups, [specProfile()]).output!
    expect(out.workloadName).toBe('burst')

    let sentName: unknown
    const fakeFetch = (async (_url, init) => {
      sentName = JSON.parse(String(init?.body)).workload_name
      return new Response(JSON.stringify({ run_id: 'r', group_id: 'g' }), { status: 200 })
    }) as typeof fetch
    await postRun(out, fakeFetch)
    expect(sentName).toBe('burst')
  })

  it('throws the server {error} on a rejected declaration', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'hardware "B200" is not in hardware_config.json' }), {
        status: 422,
      })) as typeof fetch
    await expect(postRun(output, fakeFetch)).rejects.toThrow(/B200/)
  })

  it('explains how to start the server when the fetch itself fails', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(postRun(output, fakeFetch)).rejects.toThrow(/leaderboard serve/)
  })
})

describe('catalog: every model is one the leaderboard will accept', () => {
  // schema/run.schema.json and internal/spec/spec.go both require the model to be
  // org-prefixed (this pattern). blis itself accepts a bare model_configs dir name
  // — bundledModelConfigDir strips the org — but the leaderboard's own validation
  // rejects it, so a bare entry here produces a record that fails on write.
  const ORG_PREFIXED = /^[^/]+\/[^/]+$/

  it.each(MODELS)('%s is org-prefixed', (model) => {
    expect(model).toMatch(ORG_PREFIXED)
  })

  it('offers no model interpret would flag', () => {
    for (const model of MODELS) {
      const modelIssues = interpret(valid({ model }), groups, []).issues.filter(
        (i) => i.field === 'model',
      )
      expect(modelIssues, model).toEqual([])
    }
  })
})

describe('canonical', () => {
  it('ignores key order, so two spellings of the same work compare equal', () => {
    expect(canonical({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(
      canonical({ b: { d: [3, 4], c: 2 }, a: 1 }),
    )
  })
})
