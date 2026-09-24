import { describe, it, expect } from 'vitest'
import { workloadParam, workloadsHref } from './route'

describe('workloadParam', () => {
  it('reads the workload name from the hash query', () => {
    expect(workloadParam('#/workloads?workload=chat-6rps')).toBe('chat-6rps')
    expect(workloadParam('#/declare?workload=chat-6rps')).toBe('chat-6rps')
  })

  it('decodes a name with reserved characters', () => {
    expect(workloadParam('#/workloads?workload=' + encodeURIComponent('my chat & co'))).toBe(
      'my chat & co',
    )
  })

  it('is null when there is no query, no workload key, or an empty value', () => {
    expect(workloadParam('#/workloads')).toBeNull()
    expect(workloadParam('#/workloads?foo=bar')).toBeNull()
    expect(workloadParam('#/workloads?workload=')).toBeNull()
  })
})

describe('workloadsHref', () => {
  it('builds the Catalog Workloads-tab deep link for a name', () => {
    expect(workloadsHref('chat-6rps')).toBe('#/catalog/workloads?workload=chat-6rps')
  })

  it('encodes reserved characters so the round trip is faithful', () => {
    const name = 'my chat & co'
    expect(workloadParam(workloadsHref(name))).toBe(name)
  })
})
