interface Props {
  /** The dependency's version string, as GET /api/version serves it (verbatim). */
  value: string
}

/**
 * The small, muted version string shown beside a project name in the left nav rail (e.g.
 * `Source  v0.1.7`). The value is read verbatim from the deployment's env vars
 * (LEADERBOARD_VERSION / BLIS_VERSION / BLIS_CATALOG_VERSION); it is declared, not verified,
 * so it can be stale if an operator bumps the image without the var.
 *
 * An unset value renders as the literal `unknown` rather than a blank, so a missing var is
 * visible rather than silent. App renders this only when /api/version answered, so the static
 * server-less build shows no version beside the links. Hidden when the rail collapses to an
 * icon strip (CSS), like the nav label beside it.
 */
export function RailVersion({ value }: Props) {
  return <span className="railver">{value || 'unknown'}</span>
}
