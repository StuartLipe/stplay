import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { loadPosterTint } from './lib/poster-tint'
import { coverSrc } from './lib/proxy'

export function DetailTintView({
  cover,
  className,
  children,
}: {
  cover?: string
  className: string
  children: ReactNode
}) {
  const imageUrl = coverSrc(cover)
  const [rgb, setRgb] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRgb(null)
    if (!imageUrl) return
    void loadPosterTint(cover).then((tint) => {
      if (!cancelled) setRgb(tint?.rgb ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [cover, imageUrl])

  return (
    <div
      className={`${className} detail-tint-view`}
      style={rgb ? ({ ['--detail-tint-rgb' as string]: rgb } as CSSProperties) : undefined}
    >
      <div className="detail-tint-bg" aria-hidden>
        {imageUrl ? <img className="detail-tint-blur" src={imageUrl} alt="" /> : null}
        <div
          className={`detail-tint-glow${rgb ? ' is-ready' : ''}`}
          style={
            rgb
              ? {
                  background: `radial-gradient(ellipse 85% 65% at 78% 12%, rgba(${rgb}, 0.52) 0%, rgba(${rgb}, 0.24) 42%, transparent 72%)`,
                }
              : undefined
          }
        />
        <div className="detail-tint-scrim" />
      </div>
      <div className="detail-tint-body">{children}</div>
    </div>
  )
}
