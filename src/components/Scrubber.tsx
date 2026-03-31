import { useRef, useCallback, useEffect } from 'react'
import type { TimelineEvent } from '../config/types'

interface ScrubberProps {
  scrubMs: number
  timelineStartMs: number
  timelineEndMs: number
  loopEndMs: number
  allEvents: TimelineEvent[]
  isLive: boolean
  isAutoPingPong: boolean
  autoRate: number
  onSeekStart: (ms: number) => void
  onSeek: (ms: number) => void
  onSeekEnd: (ms: number) => void
  onGoLive: () => void
  onStartAutoPingPong: () => void
}

function toPercent(ms: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.max(0, Math.min(100, ((ms - start) / (end - start)) * 100))
}

export function Scrubber({
  scrubMs,
  timelineStartMs,
  timelineEndMs,
  loopEndMs,
  allEvents,
  isLive,
  isAutoPingPong,
  autoRate,
  onSeekStart,
  onSeek,
  onSeekEnd,
  onGoLive,
  onStartAutoPingPong,
}: ScrubberProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const msFromEvent = useCallback((clientX: number): number => {
    const bar = barRef.current
    if (!bar) return scrubMs
    const rect = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return timelineStartMs + ratio * (timelineEndMs - timelineStartMs)
  }, [scrubMs, timelineStartMs, timelineEndMs])

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

  const thumbPercent = toPercent(scrubMs, timelineStartMs, timelineEndMs)
  const loopEndPercent = toPercent(loopEndMs, timelineStartMs, timelineEndMs)

  // Sample up to 50 events for markers
  const markerEvents = allEvents.length > 50
    ? allEvents.filter((_, i) => i % Math.ceil(allEvents.length / 50) === 0)
    : allEvents

  const formatTime = (ms: number) => {
    const d = new Date(ms)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 px-6 pb-6 pt-3">
      <div className="flex items-center gap-3 mb-2">
        {!isAutoPingPong ? (
          <button
            onClick={onStartAutoPingPong}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/75 transition-colors uppercase tracking-[0.2em] font-pixel"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-300/70" />
            Auto {autoRate}x
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-cyan-200/70 uppercase tracking-[0.2em] font-pixel">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-300" />
            Auto {autoRate}x
          </div>
        )}

        {!isLive ? (
          <button
            onClick={onGoLive}
            className="flex items-center gap-1.5 text-xs text-red-400 border border-red-400/40 px-2.5 py-1 rounded hover:border-red-400/70 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            LIVE
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-white/30">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </div>
        )}
      </div>

      {/* Timeline bar */}
      <div
        ref={barRef}
        className="relative h-10 bg-white/5 rounded cursor-pointer overflow-hidden"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        {/* Filled track up to scrub position */}
        <div
          className="absolute left-0 top-0 h-full bg-white/8"
          style={{ width: `${thumbPercent}%` }}
        />

        {/* Event markers */}
        {markerEvents.map(e => (
          <div
            key={e.key}
            className="absolute top-0 w-px h-full bg-white/20"
            style={{ left: `${toPercent(e.realWorldMs, timelineStartMs, timelineEndMs)}%` }}
          />
        ))}

        {/* Frozen loop end while auto mode is active */}
        {isAutoPingPong && loopEndMs > timelineStartMs && (
          <div
            className="absolute top-0 -translate-x-1/2 w-px h-full bg-cyan-300/90"
            style={{ left: `${loopEndPercent}%` }}
          />
        )}

        {/* Scrub thumb — vertical line */}
        <div
          className="absolute top-0 -translate-x-1/2 w-0.5 h-full bg-white shadow-md"
          style={{ left: `${thumbPercent}%` }}
        />
      </div>

      {/* Time labels */}
      <div className="flex justify-between mt-1.5 text-xs text-white/20 select-none">
        <span>{timelineStartMs > 0 ? formatTime(timelineStartMs) : ''}</span>
        <span>{timelineEndMs > 0 ? formatTime(timelineEndMs) : ''}</span>
      </div>
    </div>
  )
}
