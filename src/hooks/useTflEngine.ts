import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchArrivals } from '../api/tfl'
import { scheduleArrival, cancelScheduled, cancelAll, disposeEffects, playNow, preloadSampler } from '../audio/engine'
import { resolveLineSoundConfig } from '../config/tonality'
import type { AppSoundConfig, ScheduledArrival, StationSoundConfig, TimelineEvent } from '../config/types'
import stationsConfig from '../config/stations.json'

const { stations, tonality } = stationsConfig as unknown as AppSoundConfig
const POLL_WINDOW_MS = 30_000
const DISPLAY_DURATION_MS = 3000
const FADE_DURATION_MS = 700
const AUTO_PLAYBACK_RATE = 32
const configuredEngines = new Set(
  stations.flatMap((station) => Object.values(station.lines).map((line) => line.synth)),
)

type PlaybackMode = 'live' | 'scrub' | 'autoPingPong'

interface DisplayItem {
  id: string
  stationName: string
  lineName: string
  visible: boolean
}

function findNearest(events: TimelineEvent[], ms: number): TimelineEvent | null {
  if (events.length === 0) return null
  return events.reduce((best, e) =>
    Math.abs(e.realWorldMs - ms) < Math.abs(best.realWorldMs - ms) ? e : best
  )
}

export function useTflEngine() {
  const [running, setRunning] = useState(false)
  const [displayItems, setDisplayItems] = useState<DisplayItem[]>([])
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('live')
  const [scrubMs, setScrubMs] = useState(0)
  const [timelineStartMs, setTimelineStartMs] = useState(0)
  const [timelineEndMs, setTimelineEndMs] = useState(0)
  const [loopEndMs, setLoopEndMs] = useState(0)
  const [allEvents, setAllEvents] = useState<TimelineEvent[]>([])

  const scheduled = useRef(new Map<string, ScheduledArrival>())
  const allEventsRef = useRef<TimelineEvent[]>([])
  const appStartMsRef = useRef(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoPlayRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const displayTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const runningRef = useRef(false)
  const playbackModeRef = useRef<PlaybackMode>('live')
  const lastPlayedKeyRef = useRef<string | null>(null)
  const latestTimelineEndMsRef = useRef(0)
  const autoLoopStartMsRef = useRef(0)
  const autoLoopEndMsRef = useRef(0)
  const pendingLoopEndMsRef = useRef(0)
  const autoDirectionRef = useRef<1 | -1>(1)
  const autoPlayheadMsRef = useRef(0)
  const lastAutoTickMsRef = useRef(0)

  const isLive = playbackMode === 'live'

  const setMode = useCallback((mode: PlaybackMode) => {
    playbackModeRef.current = mode
    setPlaybackMode(mode)
  }, [])

  const stopAutoPlayback = useCallback(() => {
    if (autoPlayRef.current) {
      clearInterval(autoPlayRef.current)
      autoPlayRef.current = null
    }
  }, [])

  const triggerDisplay = useCallback((stationName: string, lineName: string) => {
    if (playbackModeRef.current !== 'live') return
    const id = `${stationName}-${lineName}-${Date.now()}`
    setDisplayItems(prev => [...prev, { id, stationName, lineName, visible: true }])

    const fadeOut = setTimeout(() => {
      displayTimersRef.current.delete(fadeOut)
      setDisplayItems(prev => prev.map(item => item.id === id ? { ...item, visible: false } : item))
      const remove = setTimeout(() => {
        displayTimersRef.current.delete(remove)
        setDisplayItems(prev => prev.filter(item => item.id !== id))
      }, FADE_DURATION_MS)
      displayTimersRef.current.add(remove)
    }, DISPLAY_DURATION_MS)
    displayTimersRef.current.add(fadeOut)
  }, [])

  const previewAt = useCallback((ms: number) => {
    setScrubMs(ms)
    autoPlayheadMsRef.current = ms

    const nearest = findNearest(allEventsRef.current, ms)
    if (!nearest) return

    setDisplayItems([{ id: 'seek', stationName: nearest.stationName, lineName: nearest.lineName, visible: true }])
    if (nearest.key !== lastPlayedKeyRef.current) {
      lastPlayedKeyRef.current = nearest.key
      playNow(resolveLineSoundConfig(nearest.lineConfig, tonality))
    }
  }, [])

  const pollStation = useCallback(async (station: StationSoundConfig) => {
    try {
      const predictions = await fetchArrivals(station.stationId)

      if (!runningRef.current) return

      const now = Tone.now()
      let eventsChanged = false

      for (const pred of predictions) {
        const lineConfig = station.lines[pred.lineId]
        if (!lineConfig) continue

        const arrivalSeconds = pred.timeToStation
        if (arrivalSeconds <= 0) continue

        const stableKey = `${station.stationId}_${pred.vehicleId}_${pred.lineId}`
        const arrivalTime = now + arrivalSeconds
        const realWorldMs = Date.now() + pred.timeToStation * 1000
        const existing = scheduled.current.get(stableKey)

        if (existing) {
          const timeUntilArrival = existing.expectedArrival - now
          const timeDiff = Math.abs(arrivalTime - existing.expectedArrival)
          if (timeUntilArrival < 10 || timeDiff < 15) continue
          cancelScheduled(existing.eventId)
          scheduled.current.delete(stableKey)
        }

        const resolvedConfig = resolveLineSoundConfig(lineConfig, tonality)

        const eventId = scheduleArrival(resolvedConfig, arrivalTime, () => {
          triggerDisplay(station.stationName, pred.lineName)
          scheduled.current.delete(stableKey)
        }, () => playbackModeRef.current === 'live')

        scheduled.current.set(stableKey, {
          predictionId: pred.id,
          eventId,
          stationName: station.stationName,
          lineId: pred.lineId,
          lineName: pred.lineName,
          expectedArrival: arrivalTime,
          scheduledAt: Date.now(),
          realWorldMs,
          lineConfig,
        })

        // Upsert into allEvents (sorted by realWorldMs)
        const existingEventIdx = allEventsRef.current.findIndex(e => e.key === stableKey)
        const newEvent: TimelineEvent = {
          key: stableKey,
          stationName: station.stationName,
          lineName: pred.lineName,
          realWorldMs,
          lineConfig,
        }
        if (existingEventIdx >= 0) {
          allEventsRef.current[existingEventIdx] = newEvent
        } else {
          const insertIdx = allEventsRef.current.findIndex(e => e.realWorldMs > realWorldMs)
          if (insertIdx === -1) {
            allEventsRef.current.push(newEvent)
          } else {
            allEventsRef.current.splice(insertIdx, 0, newEvent)
          }
        }
        eventsChanged = true

        latestTimelineEndMsRef.current = Math.max(latestTimelineEndMsRef.current, realWorldMs)
        setTimelineEndMs(prev => Math.max(prev, realWorldMs))
        if (playbackModeRef.current === 'autoPingPong') {
          pendingLoopEndMsRef.current = Math.max(pendingLoopEndMsRef.current, realWorldMs)
        }
      }

      if (eventsChanged) {
        setAllEvents([...allEventsRef.current])
      }

      const transportNow = Tone.now()
      for (const [key, entry] of scheduled.current) {
        if (entry.expectedArrival < transportNow - 10) {
          cancelScheduled(entry.eventId)
          scheduled.current.delete(key)
        }
      }

      const next5 = [...scheduled.current.values()]
        .sort((a, b) => a.expectedArrival - b.expectedArrival)
        .slice(0, 5)

      console.log(
        next5.length > 0
          ? `Next ${next5.length} events:\n` +
            next5.map((e) => {
              const delta = e.expectedArrival - Tone.now()
              return `  +${Math.round(delta)}s  ${e.stationName} · ${e.lineName}`
            }).join('\n')
          : 'No upcoming events'
      )
    } catch (err) {
      console.error(`Poll error for ${station.stationName}:`, err)
    }
  }, [triggerDisplay])

  const start = useCallback(async () => {
    await Tone.start()
    await Promise.all([...configuredEngines].map((engine) => preloadSampler(engine)))
    Tone.getTransport().start()
    runningRef.current = true
    appStartMsRef.current = Date.now()
    latestTimelineEndMsRef.current = 0
    autoLoopStartMsRef.current = appStartMsRef.current
    autoLoopEndMsRef.current = 0
    pendingLoopEndMsRef.current = 0
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = appStartMsRef.current
    lastAutoTickMsRef.current = 0
    stopAutoPlayback()
    setMode('live')
    setTimelineStartMs(appStartMsRef.current)
    setScrubMs(appStartMsRef.current)
    setLoopEndMs(0)
    setRunning(true)

    const stagger = POLL_WINDOW_MS / stations.length

    stations.forEach((station, i) => {
      setTimeout(() => pollStation(station), i * stagger)
    })

    intervalRef.current = setInterval(() => {
      stations.forEach((station, i) => {
        setTimeout(() => pollStation(station), i * stagger)
      })
    }, POLL_WINDOW_MS)
  }, [pollStation, setMode, stopAutoPlayback])

  const stop = useCallback(() => {
    runningRef.current = false
    stopAutoPlayback()
    setMode('live')

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    displayTimersRef.current.forEach(t => clearTimeout(t))
    displayTimersRef.current.clear()

    cancelAll()
    scheduled.current.clear()
    allEventsRef.current = []
    setAllEvents([])
    latestTimelineEndMsRef.current = 0
    autoLoopStartMsRef.current = 0
    autoLoopEndMsRef.current = 0
    pendingLoopEndMsRef.current = 0
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = 0
    lastAutoTickMsRef.current = 0
    setTimelineStartMs(0)
    setTimelineEndMs(0)
    setLoopEndMs(0)

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setDisplayItems([])
  }, [setMode, stopAutoPlayback])

  // Live-time ticker: advance scrubMs to Date.now() every 500ms when in live mode
  useEffect(() => {
    if (!running || !isLive) return
    const id = setInterval(() => setScrubMs(Date.now()), 500)
    return () => clearInterval(id)
  }, [running, isLive])

  const seek = useCallback((ms: number) => {
    stopAutoPlayback()
    setMode('scrub')
    setLoopEndMs(0)
    previewAt(ms)
  }, [previewAt, setMode, stopAutoPlayback])

  const seekAndPlay = seek

  const goLive = useCallback(() => {
    stopAutoPlayback()
    setMode('live')
    setLoopEndMs(0)
    setScrubMs(Date.now())
    autoPlayheadMsRef.current = Date.now()
    lastPlayedKeyRef.current = null
    setDisplayItems([])
  }, [setMode, stopAutoPlayback])

  const startAutoPingPong = useCallback(() => {
    if (!runningRef.current) return

    const loopStart = timelineStartMs
    const loopEnd = latestTimelineEndMsRef.current
    const loopSpan = loopEnd - loopStart
    if (loopSpan <= 0) return

    stopAutoPlayback()
    setMode('autoPingPong')
    autoLoopStartMsRef.current = loopStart
    autoLoopEndMsRef.current = loopEnd
    pendingLoopEndMsRef.current = loopEnd
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = loopStart
    lastAutoTickMsRef.current = Date.now()
    lastPlayedKeyRef.current = null
    setLoopEndMs(loopEnd)
    previewAt(loopStart)

    autoPlayRef.current = setInterval(() => {
      const activeLoopStart = autoLoopStartMsRef.current
      const activeLoopEnd = autoLoopEndMsRef.current
      if (activeLoopEnd <= activeLoopStart) return

      const now = Date.now()
      const elapsedMs = now - lastAutoTickMsRef.current
      lastAutoTickMsRef.current = now

      let nextMs = autoPlayheadMsRef.current + elapsedMs * AUTO_PLAYBACK_RATE * autoDirectionRef.current
      let direction = autoDirectionRef.current
      let restartedAtStart = false

      while (nextMs > activeLoopEnd || nextMs < activeLoopStart) {
        if (nextMs > activeLoopEnd) {
          nextMs = activeLoopEnd - (nextMs - activeLoopEnd)
          direction = -1
        } else {
          nextMs = activeLoopStart + (activeLoopStart - nextMs)
          direction = 1
          restartedAtStart = true
        }
      }

      autoDirectionRef.current = direction
      autoPlayheadMsRef.current = nextMs

      if (restartedAtStart) {
        const nextLoopEnd = Math.max(pendingLoopEndMsRef.current, activeLoopStart)
        autoLoopEndMsRef.current = nextLoopEnd
        setLoopEndMs(nextLoopEnd)
      }

      previewAt(nextMs)
    }, 100)
  }, [previewAt, setMode, stopAutoPlayback, timelineStartMs])

  useEffect(() => {
    const displayTimers = displayTimersRef.current
    const scheduledEvents = scheduled.current

    return () => {
      runningRef.current = false
      stopAutoPlayback()
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      displayTimers.forEach(t => clearTimeout(t))
      displayTimers.clear()
      cancelAll()
      scheduledEvents.clear()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      disposeEffects()
    }
  }, [stopAutoPlayback])

  return {
    running,
    displayItems,
    start,
    stop,
    playbackMode,
    autoRate: AUTO_PLAYBACK_RATE,
    isLive,
    scrubMs,
    timelineStartMs,
    timelineEndMs,
    loopEndMs,
    allEvents,
    seek,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  }
}
