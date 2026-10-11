import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type SeasonSelectOption = {
  value: string
  label: string
}

export function SeasonSelect({
  options,
  value,
  onChange,
  className = '',
  ariaLabel = 'Temporada',
}: {
  options: SeasonSelectOption[]
  value: string
  onChange: (value: string) => void
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!selected) return null

  return (
    <div ref={rootRef} className={`season-select${open ? ' is-open' : ''} ${className}`.trim()}>
      <button
        type="button"
        className="season-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="season-select-label">{selected.label}</span>
        <ChevronDown size={16} className="season-select-chevron" aria-hidden />
      </button>
      {open && (
        <div className="season-select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`season-select-option${active ? ' active' : ''}`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {active ? <Check size={14} strokeWidth={2.4} aria-hidden /> : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
