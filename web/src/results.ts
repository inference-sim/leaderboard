import type { RunRecord } from './load'

// The results API: read every stored run, and delete one. Both talk to the same
// `leaderboard serve` endpoints the board already uses; deleting a run removes its
// results/<group_id>/<run_id>.json (and any .requests.json sidecar) from disk, so it is
// only possible with the server up. The static build has no server, so the board hides
// the delete affordance rather than calling this. fetchImpl is injectable for tests.

const UNREACHABLE =
  'Could not reach the run server. Start it with `make build && ./bin/leaderboard serve`, ' +
  'then try again.'

/** GET /api/results — every stored record, or a rejection when no server is up. */
export async function fetchResults(fetchImpl: typeof fetch = fetch): Promise<RunRecord[]> {
  let res: Response
  try {
    res = await fetchImpl('/api/results')
  } catch {
    throw new Error(UNREACHABLE)
  }
  return (await readOrThrow(res)) as RunRecord[]
}

/**
 * DELETE /api/results/{group}/{run} — remove one stored run. The two path segments are
 * escaped, though the server validates them again before touching disk. A blis-style
 * {error} body is surfaced verbatim; a dead server becomes the "start the server" note.
 */
export async function deleteRun(
  groupId: string,
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `/api/results/${encodeURIComponent(groupId)}/${encodeURIComponent(runId)}`
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'DELETE' })
  } catch {
    throw new Error(UNREACHABLE)
  }
  const body = await readOrThrow(res)
  // The delete endpoint answers {"deleted": run_id}. A server that predates this route has
  // no handler for DELETE /api/results/{group}/{run}, so the request falls through to the
  // SPA catch-all and comes back 200 with index.html — which readOrThrow parses to null and
  // lets pass. Without this check that reads as a silent success: the reload re-fetches the
  // run that was never removed and the row reappears with no error. Requiring the
  // acknowledgement turns that into a clear, actionable message instead.
  if (!body || typeof body !== 'object' || !('deleted' in body)) {
    throw new Error(
      'The server did not confirm the delete. The running `leaderboard serve` may predate ' +
        'this feature — rebuild it with `make build` and restart it, then try again.',
    )
  }
}

/**
 * Parses a JSON response, throwing the endpoint's own {error} message on a non-2xx (or a
 * plain HTTP-status message when the body is not the expected shape). Mirrors the reader
 * in workloads.ts so the results and workload APIs fail the same way.
 */
async function readOrThrow(res: Response): Promise<unknown> {
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `The run server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return parsed
}
