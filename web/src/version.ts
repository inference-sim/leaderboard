// The deployment version API: which build of each first-party dependency the running
// server is made of. GET /api/version answers {leaderboard, blis, catalog}, read from env
// vars the deployment sets (see the design doc). It is deployment-level, display-only
// provenance; it is unrelated to the per-run provenance.blis_commit each record carries.
//
// A rejection means "no version endpoint here" — the static committed board served with no
// backend, or a `leaderboard serve` old enough to predate the route (its SPA catch-all
// answers 200 with index.html, which is not the expected shape). The version block stays
// hidden in that case, so the static build is visually unchanged. fetchImpl is injectable
// for tests.

export interface Versions {
  leaderboard: string
  blis: string
  catalog: string
}

/** GET /api/version — the three dependency versions, or a rejection when there is no
 * version endpoint to answer (so App hides the version block). */
export async function fetchVersion(fetchImpl: typeof fetch = fetch): Promise<Versions> {
  const res = await fetchImpl('/api/version')
  if (!res.ok) {
    throw new Error(`/api/version returned HTTP ${res.status}`)
  }
  const parsed: unknown = await res.json()
  // Require the exact shape: an older serve with no /api/version route falls through to the
  // SPA catch-all and answers 200 with index.html, which parses to something without these
  // keys. Treat that as "no endpoint" and let the block hide, rather than render blanks.
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Versions).leaderboard !== 'string' ||
    typeof (parsed as Versions).blis !== 'string' ||
    typeof (parsed as Versions).catalog !== 'string'
  ) {
    throw new Error('/api/version did not return the expected shape')
  }
  const v = parsed as Versions
  return { leaderboard: v.leaderboard, blis: v.blis, catalog: v.catalog }
}
