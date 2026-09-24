import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups, loadWorkloads, workloadKey, workloadTitle } from './load'
import type { RunRecord } from './load'
import { initialValues, interpret } from './newrun'
import type { FormValues } from './newrun'
import { rowId, runDeclFromOutput, workloadKeyForGroup } from './liverun'

const records = fixture as unknown as RunRecord[]
const groups = loadGroups(records)
const workloads = loadWorkloads(records)
const main = groups.find((g) => g.groupId === '5063e40dceb2')!

/** A custom-workload form, the same shape newrun.test.ts uses. The custom card authors a
 * single-client gaussian workload-spec now, so it names its own workload, not the
 * fixture's flat-distribution main group. A custom workload is saved to the catalog on
 * Run, so it carries a name. */
function valid(overrides: Partial<FormValues> = {}): FormValues {
  return { ...initialValues(), runId: 'h100-tp8', tp: '8', customName: 'custom-run', ...overrides }
}

describe('rowId', () => {
  it('is run-<group_id>-<run_id>, keyed on identity not position', () => {
    expect(rowId({ group_id: '5063e40dceb2', run_id: 'h100-tp1' })).toBe(
      'run-5063e40dceb2-h100-tp1',
    )
  })

  it('matches the id a real record carries', () => {
    const r = main.complete[0]!
    expect(rowId(r)).toBe(`run-${r.group_id}-${r.run_id}`)
  })
})

describe('runDeclFromOutput', () => {
  const output = interpret(valid(), groups, []).output!

  it('carries the run id and the model from the deployment', () => {
    const decl = runDeclFromOutput(output)
    expect(decl.runId).toBe('h100-tp8')
    expect(decl.model).toBe(output.deployment.model)
  })

  it('names the workload the same way the board does, from the group block alone', () => {
    const decl = runDeclFromOutput(output)
    expect(decl.workloadKey).toBe(workloadKey(output.group))
    expect(decl.workloadTitle).toBe(workloadTitle(output.group))
  })
})

describe('workloadKeyForGroup', () => {
  it('finds the workload holding a known group', () => {
    const key = workloadKeyForGroup(workloads, main.groupId)
    expect(key).toBe(workloadKey(main.group))
    expect(workloads.find((w) => w.workloadKey === key)!.groups).toContainEqual(
      expect.objectContaining({ groupId: main.groupId }),
    )
  })

  it('returns null for a group not present in the loaded workloads', () => {
    expect(workloadKeyForGroup(workloads, 'deadbeefdead')).toBeNull()
  })
})
