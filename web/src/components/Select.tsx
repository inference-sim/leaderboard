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
}

/**
 * A styled dropdown that replaces the native `<select>`, so the open option list wears the
 * page's own design rather than the OS list a native control draws (which CSS cannot reach).
 * It is the listbox/combobox ARIA pattern: focus stays on the trigger, the active option is
 * tracked with aria-activedescendant, and every option stays in the DOM (hidden until open)
 * so the markup renders the same on the server and in tests as it does live.
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
}: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null

  // Close when the focus or a click leaves the control.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const firstEnabled = () => {
    const i = options.findIndex((o) => !o.disabled)
    return i < 0 ? 0 : i
  }
  const openList = () => {
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled())
    setOpen(true)
  }
  const choose = (i: number) => {
    const opt = options[i]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    setOpen(false)
  }
  const move = (delta: number) =>
    setActive((a) => {
      let n = a
      for (let step = 0; step < options.length; step++) {
        n = (n + delta + options.length) % options.length
        if (!options[n]?.disabled) return n
      }
      return a
    })

  const onKeyDown = (e: React.KeyboardEvent) => {
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
          setActive(firstEnabled())
        }
        break
      case 'End':
        if (open) {
          e.preventDefault()
          for (let i = options.length - 1; i >= 0; i--)
            if (!options[i]?.disabled) {
              setActive(i)
              break
            }
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        open ? choose(active) : openList()
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
        onKeyDown={onKeyDown}
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
      <ul
        id={listId}
        role="listbox"
        className="sel-list"
        hidden={!open}
        tabIndex={-1}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
      >
        {options.map((o, i) => (
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
      </ul>
    </div>
  )
}
