/** Number formatting. A table that mixes 31.42823 and 9749.57464 is unreadable. */

const EM_DASH = '—'

/**
 * Renders a duration. Sub-second values stay in milliseconds where a tenth still
 * means something; a second and over switches to seconds, because five significant
 * digits of milliseconds is noise.
 */
export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH
  if (value >= 1000) return `${formatNumber(value / 1000, 2)}s`
  return `${formatNumber(value, 1)}ms`
}

/** Renders a number with thousands grouping at a fixed precision. */
export function formatNumber(value: number | null | undefined, digits: number): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Renders an integer count. */
export function formatCount(value: number | null | undefined): string {
  return formatNumber(value, 0)
}
