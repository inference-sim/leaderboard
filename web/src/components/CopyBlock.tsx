import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  /** What this block is, in the reader's terms. */
  label: string
  /** The caption under the label: what to do with the text, and anything needed to read it right. */
  hint?: ReactNode
  text: string
}

/**
 * A block of text meant to leave the page. The button reports what happened rather
 * than animating: "Copied" replaces "Copy" for two seconds, and a browser that
 * refuses clipboard access says so instead of failing silently, because the text is
 * selectable either way.
 */
export function CopyBlock({ label, hint, text }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('blocked')
    }
  }

  return (
    <div className="copyblock">
      <div className="copyhead">
        <h4>{label}</h4>
        {hint && <p>{hint}</p>}
      </div>
      {/* The copy button lives on the command block, not up by the title, so it is
       * unambiguous which text it copies. It floats in the block's top-right corner and
       * scrolls with neither the horizontal command overflow nor the page. */}
      <div className="copybody">
        <button type="button" className="copybtn" onClick={copy} aria-live="polite">
          <svg className="copyico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
            <path d="M3.5 10.5h-.5A1.5 1.5 0 0 1 1.5 9V2.5A1.5 1.5 0 0 1 3 1h6A1.5 1.5 0 0 1 10.5 2.5v.5" />
          </svg>
          {state === 'copied' ? 'Copied' : state === 'blocked' ? 'Select it instead' : 'Copy'}
        </button>
        <pre>
          <code>{text}</code>
        </pre>
      </div>
    </div>
  )
}
