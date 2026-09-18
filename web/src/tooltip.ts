/**
 * Renders the `data-tip` explanations (`.derived`, `.info`, `.eq`) as a single tooltip
 * element parked at the end of `<body>`, positioned under (or over) whatever the pointer
 * or keyboard focus is on.
 *
 * Why a body-level element and not a CSS `::after` on the trigger: the readout table
 * scrolls horizontally, so its scroll container clips an absolutely positioned tooltip
 * that pops past the table's top or bottom edge — a header note on a short table gets cut
 * off by the first row. And a header cell is its own stacking context (`z-index: 2` for the
 * sticky header), so a note anchored inside one is painted *under* the neighbouring header
 * cells — its top edge disappears behind the column titles. A `position: fixed` box at the
 * document root sidesteps both: nothing clips it and nothing outranks it.
 *
 * The trigger keeps its `data-tip` and `aria-label` (assistive tech reads those); this box
 * is `aria-hidden`, a sighted-user affordance only.
 */
const EDGE = 8 // keep this far from the viewport edges
const GAP = 6 // between the trigger and the tooltip

let tip: HTMLElement | null = null
let current: HTMLElement | null = null

function box(): HTMLElement {
  if (tip) return tip
  const el = document.createElement('div')
  el.className = 'tip'
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  tip = el
  return el
}

function show(trigger: HTMLElement): void {
  const text = trigger.getAttribute('data-tip')
  if (!text) return
  current = trigger
  const el = box()
  el.textContent = text
  // Measured while still hidden: `visibility: hidden` (the resting state) still lays the
  // box out, so its width/height are known before it is placed and revealed.
  const r = trigger.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  const belowY = r.bottom + GAP
  const openUp = belowY + h > window.innerHeight - EDGE && r.top - GAP - h > EDGE
  const y = openUp ? r.top - GAP - h : belowY
  const x = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE))
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y)}px`
  el.classList.add('show')
}

function hide(trigger?: HTMLElement): void {
  // Ignore a stale hide from a trigger we already moved off of.
  if (trigger && trigger !== current) return
  current = null
  tip?.classList.remove('show')
}

/**
 * Wires the tooltip to pointer and keyboard focus, once, for the whole document. Capture
 * phase + `closest` so it catches events on any inner node and on triggers added later (a
 * run declared this session). A scroll or resize retires the open tip rather than leaving
 * it stranded at a now-wrong spot. Returns a teardown for tests.
 */
export function initTooltips(): () => void {
  const onOver = (e: Event): void => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (t) show(t)
  }
  const onOut = (e: Event): void => {
    const me = e as MouseEvent
    const t = (me.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
    // Only hide when the pointer actually left the trigger, not on a move within it.
    if (t && !t.contains(me.relatedTarget as Node | null)) hide(t)
  }
  const onFocusIn = (e: Event): void => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (t) show(t)
  }
  const onFocusOut = (e: Event): void => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (t) hide(t)
  }
  const onScroll = (): void => hide()
  document.addEventListener('pointerover', onOver, true)
  document.addEventListener('pointerout', onOut, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll, true)
  return () => {
    document.removeEventListener('pointerover', onOver, true)
    document.removeEventListener('pointerout', onOut, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onScroll, true)
    tip?.remove()
    tip = null
    current = null
  }
}
