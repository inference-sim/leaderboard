import { useEffect, useId, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  /** The text shown in the trigger and the option row. */
  label: string
  /** Optional muted trailing note, e.g. "preset". */
  hint?: string
  disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** Set on the trigger, so a sibling `<label htmlFor>` focuses it. */
  id?: string
  /** id of the visible label element (preferred over ariaLabel when there is one). */
  labelledBy?: string
  /** Accessible name when there is no visible label to point at. */
  ariaLabel?: string
  /** Shown when no option matches `value`. */
  placeholder?: string
  className?: string
  /** Disables the whole control: the trigger cannot be opened and reads as inactive. */
  disabled?: boolean
  /** When set, the open list carries a filter box the reader can type into to narrow a long
   * list (e.g. the model catalog). Off by default, so other selects are unchanged. */
  searchable?: boolean
}

/** filterOptions narrows a list to those whose label or value contains the query (case- and
 * space-insensitive at the ends). A blank query returns the list unchanged. Exported so the
 * filtering is unit-tested without driving the component's open state. */
export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q))
}

/**
 * A styled dropdown that replaces the native `<select>`, so the open option list wears the
 * page's own design rather than the OS list a native control draws (which CSS cannot reach).
 * It is the listbox/combobox ARIA pattern: focus stays on the trigger, the active option is
 * tracked with aria-activedescendant, and every option stays in the DOM (hidden until open)
 * so the markup renders the same on the server and in tests as it does live.
 *
 * With `searchable`, the open list gains a filter input the reader can type into; focus moves
 * to it while open and the keyboard navigation runs from there.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  labelledBy,
  ariaLabel,
  placeholder,
  className,
  disabled,
  searchable,
}: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // The trigger always shows the selection from the full list (even when the filter would
  // hide it); navigation and choosing run over the filtered rows.
  const selected = options.find((o) => o.value === value) ?? null
  const rows = searchable && open ? filterOptions(options, query) : options

  // Close when the focus or a click leaves the control.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the filter box when a searchable list opens, so the reader can type straight away.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  const firstEnabledIn = (list: SelectOption[]) => {
    const i = list.findIndex((o) => !o.disabled)
    return i < 0 ? 0 : i
  }
  const openList = () => {
    setQuery('')
    const sel = options.findIndex((o) => o.value === value)
    setActive(sel >= 0 ? sel : firstEnabledIn(options))
    setOpen(true)
  }
  const choose = (i: number) => {
    const opt = rows[i]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    setOpen(false)
  }
  const move = (delta: number) =>
    setActive((a) => {
      let n = a
      for (let step = 0; step < rows.length; step++) {
        n = (n + delta + rows.length) % rows.length
        if (!rows[n]?.disabled) return n
      }
      return a
    })
  const lastEnabled = () => {
    for (let i = rows.length - 1; i >= 0; i--) if (!rows[i]?.disabled) return i
    return 0
  }

  // Shared navigation for the trigger (closed, and open when not searchable) and the filter
  // box (open when searchable). `typing` is true for the filter box, where Space must type a
  // space rather than choose the active option.
  const navKeys = (e: React.KeyboardEvent, typing: boolean) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        open ? move(1) : openList()
        break
      case 'ArrowUp':
        e.preventDefault()
        open ? move(-1) : openList()
        break
      case 'Home':
        if (open) {
          e.preventDefault()
          setActive(firstEnabledIn(rows))
        }
        break
      case 'End':
        if (open) {
          e.preventDefault()
          setActive(lastEnabled())
        }
        break
      case 'Enter':
        e.preventDefault()
        open ? choose(active) : openList()
        break
      case ' ':
        if (!typing) {
          e.preventDefault()
          open ? choose(active) : openList()
        }
        break
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div className={`sel${open ? ' open' : ''}${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        id={id}
        className="sel-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => navKeys(e, false)}
      >
        <span className={selected ? 'sel-value' : 'sel-value sel-empty'}>
          {selected ? (
            <>
              {selected.label}
              {selected.hint && <span className="sel-hint">{selected.hint}</span>}
            </>
          ) : (
            placeholder ?? 'Select…'
          )}
        </span>
        <svg className="sel-arrow" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="sel-pop" hidden={!open}>
        {searchable && open && (
          <input
            ref={searchRef}
            type="text"
            className="sel-search"
            placeholder="Type to filter…"
            aria-label="Filter options"
            aria-controls={listId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(firstEnabledIn(filterOptions(options, e.target.value)))
            }}
            onKeyDown={(e) => navKeys(e, true)}
          />
        )}
        <ul
          id={listId}
          role="listbox"
          className="sel-list"
          hidden={!open}
          tabIndex={-1}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
        >
          {rows.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`sel-opt${i === active && open ? ' active' : ''}${o.value === value ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => {
                // mousedown, not click: fire before the trigger's blur closes the list.
                e.preventDefault()
                choose(i)
              }}
            >
              <span className="sel-opt-label">{o.label}</span>
              {o.hint && <span className="sel-hint">{o.hint}</span>}
            </li>
          ))}
          {rows.length === 0 && (
            <li className="sel-opt sel-noopt" aria-disabled>
              No matches
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
