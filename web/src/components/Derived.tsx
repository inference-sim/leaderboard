import type { ReactNode } from 'react'

interface Props {
  /** The formula, named in full. Shown on hover and to assistive technology. */
  formula: string
  children: ReactNode
}

/**
 * Wraps a value the leaderboard computed rather than read from BLIS. The dotted
 * underline is not decoration: it is the difference between a number BLIS stands
 * behind and one this repo derived from flags.
 *
 * Focusable (`tabIndex 0`) so the explanation is reachable by keyboard, not only
 * by a mouse hovering for the native `title`. `title` does not show reliably on
 * keyboard focus, so the visible tooltip is instead driven by CSS from
 * `data-tip` (see `.derived::after` in styles.css), which fires on both
 * `:hover` and `:focus-visible`. `role="note"` plus `aria-label` still carry the
 * text to assistive technology, which does not read CSS-generated content.
 */
export function Derived({ formula, children }: Props) {
  return (
    <span className="derived" tabIndex={0} role="note" data-tip={formula} aria-label={`Computed: ${formula}`}>
      {children}
    </span>
  )
}
