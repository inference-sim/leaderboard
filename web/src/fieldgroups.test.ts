import { describe, expect, it } from 'vitest'
import schema from '../../schema/run.schema.json'
import { FIELD_GROUPS, SEPARATELY_RENDERED } from './fieldgroups'

/**
 * The Declare form's flag-group titles, in the order NewRun.tsx renders them (the seven
 * flagGroup(...) calls in the "Candidate under test" fieldset, then the "Simulation model"
 * fieldset). fieldgroups.ts must match this exactly so "grouped like Declare" is enforced
 * by shared code rather than by eye.
 */
const DECLARE_ORDER = [
  'Model & sharding',
  'Scheduling & batching',
  'KV cache',
  'Cluster',
  'Prefill/decode split',
  'Admission & routing',
  'Speculative decoding',
  'Simulation model',
]

describe('FIELD_GROUPS', () => {
  it('lists the Declare-form group titles in the same order', () => {
    expect(FIELD_GROUPS.map((g) => g.title)).toEqual(DECLARE_ORDER)
  })

  it('covers every Deployment key: union of group fields plus the separately-rendered keys equals the schema key set', () => {
    // The schema is the source of truth for the Deployment shape (types.ts is generated
    // from it). Reaching into $defs.deployment.properties catches a field added to the
    // schema but forgotten in a group.
    const defs = (schema as unknown as { $defs: Record<string, { properties: Record<string, unknown> }> }).$defs
    const deployment = defs.deployment
    if (!deployment) throw new Error('schema has no $defs.deployment')
    const schemaKeys = new Set(Object.keys(deployment.properties))

    const grouped = FIELD_GROUPS.flatMap((g) => g.fields)
    // No field appears in two groups.
    expect(new Set(grouped).size).toBe(grouped.length)

    const covered = new Set([...grouped, ...SEPARATELY_RENDERED])
    expect(covered).toEqual(schemaKeys)
  })
})
