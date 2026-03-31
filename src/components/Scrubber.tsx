import { useRef, useCallback, useEffect } from 'react'
import type { TimelineEvent } from '../config/types'

interface ScrubberProps {
  scrubMs: number
  timelineStartMs: number
  timelineEndMs: number
  loopStartMs: number
  loopEndMs: number
  allEvents: TimelineEvent[]
  lineColors: Record<string, string>
  isLive: boolean
  isAutoPingPong: boolean
  autoRate: number
  audioReady: boolean
  hasTimeline: boolean
  running: boolean
  onSeekStart: (ms: number) => void | Promise<void>
  onSeek: (ms: number) => void | Promise<void>
  onSeekEnd: (ms: number) => void | Promise<void>
  onGoLive: () => void | Promise<void>
  onStartAutoPingPong: (rate: number) => void | Promise<void>
  onStart: () => void | Promise<void>
  onStop: () => void
}

function toPercent(ms: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.max(0, Math.min(100, ((ms - start) / (end - start)) * 100))
}

export function Scrubber({
  scrubMs,
  timelineStartMs,
  timelineEndMs,
  loopStartMs,
  loopEndMs,
  allEvents,
  lineColors,
  isLive,
  isAutoPingPong,
  autoRate,
  audioReady,
  hasTimeline,
  running,
  onSeekStart,
  onSeek,
  onSeekEnd,
  onGoLive,
  onStartAutoPingPong,
  onStart,
  onStop,
}: ScrubberProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const windowStartMs = isAutoPingPong && loopEndMs > loopStartMs ? loopStartMs : timelineStartMs
  const windowEndMs = isAutoPingPong && loopEndMs > loopStartMs ? loopEndMs : timelineEndMs

  const msFromEvent = useCallback((clientX: number): number => {
    const bar = barRef.current
    if (!bar) return scrubMs
    const rect = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return windowStartMs + ratio * (windowEndMs - windowStartMs)
  }, [scrubMs, windowEndMs, windowStartMs])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    onSeekStart(msFromEvent(e.clientX))
  }, [msFromEvent, onSeekStart])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    draggingRef.current = true
    onSeekStart(msFromEvent(e.touches[0].clientX))
  }, [msFromEvent, onSeekStart])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      onSeek(msFromEvent(e.clientX))
    }
    const handleMouseUp = (e: MouseEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      onSeekEnd(msFromEvent(e.clientX))
    }
    const handleTouchMove = (e: TouchEvent) => {
      if (!draggingRef.current) return
      onSeek(msFromEvent(e.touches[0].clientX))
    }
    const handleTouchEnd = (e: TouchEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      onSeekEnd(msFromEvent(e.changedTouches[0].clientX))
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    window.addEventListener('touchend', handleTouchEnd)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [msFromEvent, onSeek, onSeekEnd])

  const thumbPercent = toPercent(scrubMs, windowStartMs, windowEndMs)
  const loopStartPercent = toPercent(loopStartMs, timelineStartMs, timelineEndMs)
  const loopEndPercent = toPercent(loopEndMs, timelineStartMs, timelineEndMs)

  // Sample up to 500 events for markers
  const markerEvents = allEvents.length > 500
    ? allEvents.filter((_, i) => i % Math.ceil(allEvents.length / 500) === 0)
    : allEvents

  const formatTime = (ms: number) => {
    const d = new Date(ms)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 px-4 pb-8 pt-3 sm:px-6 sm:pb-6">
      {hasTimeline && (
        <div className="flex items-center gap-2 sm:gap-3 mb-2">
          {[4, 16].map(rate =>
            isAutoPingPong && autoRate === rate ? (
              <div key={rate} className="flex items-center gap-1.5 text-xs text-cyan-600 border border-cyan-500/50 dark:text-cyan-200 dark:border-cyan-300/40 px-2.5 py-1 rounded uppercase tracking-[0.2em] font-pixel">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 dark:bg-cyan-300 animate-pulse" />
                Auto {rate}x
              </div>
            ) : (
              <button
                key={rate}
                onClick={() => onStartAutoPingPong(rate)}
                className="flex items-center gap-1.5 text-xs text-cyan-600/50 border border-cyan-600/25 hover:text-cyan-600/80 hover:border-cyan-600/50 dark:text-cyan-300/40 dark:border-cyan-300/20 dark:hover:text-cyan-300/70 dark:hover:border-cyan-300/50 transition-colors px-2.5 py-1 rounded uppercase tracking-[0.2em] font-pixel"
              >
                Auto {rate}x
              </button>
            )
          )}

          {!isLive ? (
            <button
              onClick={onGoLive}
              className="flex items-center gap-1.5 text-xs text-red-500/60 border border-red-500/30 hover:text-red-500/90 hover:border-red-500/60 dark:text-red-400/50 dark:border-red-400/25 dark:hover:text-red-400/80 dark:hover:border-red-400/55 transition-colors px-2.5 py-1 rounded uppercase tracking-[0.2em] font-pixel"
            >
              LIVE
            </button>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-red-600 border border-red-500/60 dark:text-red-400 dark:border-red-400/50 px-2.5 py-1 rounded uppercase tracking-[0.2em] font-pixel">
              <span className="w-1.5 h-1.5 rounded-full bg-red-600 dark:bg-red-500 animate-pulse" />
              LIVE
            </div>
          )}
        </div>
      )}

      {/* Timeline bar with play button */}
      <div className="flex items-start gap-3">
        <button
          disabled={!hasTimeline}
          onClick={running ? onStop : onStart}
          className="w-11 h-11 rounded-full border border-fg/25 hover:border-fg/50 disabled:opacity-35 disabled:hover:border-fg/25 transition-colors flex items-center justify-center shrink-0"
          title={audioReady ? undefined : 'Unlock audio and start playback'}
        >
          {running ? (
            <div className="w-2.5 h-2.5 rounded-sm bg-fg/70" />
          ) : (
            <div className="w-0 h-0 border-l-[8px] border-l-fg/70 border-y-[6px] border-y-transparent ml-0.5" />
          )}
        </button>
        <div className="flex-1">
          <div
            ref={barRef}
            className="relative h-10 bg-fg/5 rounded cursor-pointer overflow-hidden"
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
          >
            {/* Filled track up to scrub position */}
            <div
              className="absolute left-0 top-0 h-full bg-fg/8"
              style={{ width: `${thumbPercent}%` }}
            />

            {/* Event markers */}
            {markerEvents.map(e => (
              <div
                key={e.key}
                className="absolute top-0 w-px h-full opacity-50"
                style={{
                  left: `${toPercent(e.realWorldMs, windowStartMs, windowEndMs)}%`,
                  backgroundColor: lineColors[e.lineId] ?? 'rgba(255,255,255,0.4)',
                }}
              />
            ))}

            {/* Active auto-loop window within the full buffered range */}
            {isAutoPingPong && loopStartMs > timelineStartMs && (
              <div
                className="absolute top-0 -translate-x-1/2 w-px h-full bg-cyan-300/40"
                style={{ left: `${loopStartPercent}%` }}
              />
            )}
            {isAutoPingPong && loopEndMs > timelineStartMs && (
              <div
                className="absolute top-0 -translate-x-1/2 w-px h-full bg-cyan-300/90"
                style={{ left: `${loopEndPercent}%` }}
              />
            )}

            {/* Scrub thumb — vertical line */}
            {timelineEndMs > 0 && (
              <div
                className="absolute top-0 -translate-x-1/2 w-0.5 h-full bg-fg shadow-md"
                style={{ left: `${thumbPercent}%` }}
              />
            )}
          </div>

          {/* Time labels */}
          <div className="flex justify-between mt-1.5 text-xs text-fg/20 select-none">
            <span>{timelineStartMs > 0 ? formatTime(timelineStartMs) : ''}</span>
            <span>{timelineEndMs > 0 ? formatTime(timelineEndMs) : ''}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
