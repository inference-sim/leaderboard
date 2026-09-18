/**
 * The `?workload=<name>` deep link, shared by the two places that carry it: the Declare
 * form (`#/declare?workload=…`, which preselects the workload to run) and the Workloads
 * tab (`#/workloads?workload=…`, which opens that saved workload's card). Keeping the
 * convention in one module means the reader and the writer cannot drift apart.
 */

/** The workload name in the route hash's query, or null when absent or empty. */
export function workloadParam(hash: string): string | null {
  const q = hash.indexOf('?')
  if (q < 0) return null
  const name = new URLSearchParams(hash.slice(q + 1)).get('workload')
  return name === '' ? null : name
}

/** The Workloads-tab route that opens on a named workload's card. */
export function workloadsHref(name: string): string {
  return `#/workloads?workload=${encodeURIComponent(name)}`
}
