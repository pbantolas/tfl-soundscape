import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchArrivals } from '../api/tfl'
import { scheduleArrival, cancelScheduled, cancelAll, disposeEffects, playNow } from '../audio/engine'
import { resolveLineSoundConfig } from '../config/tonality'
import type { AppSoundConfig, ScheduledArrival, StationSoundConfig, TimelineEvent } from '../config/types'
import stationsConfig from '../config/stations.json'

const { stations, tonality } = stationsConfig as unknown as AppSoundConfig
const POLL_WINDOW_MS = 30_000
const DISPLAY_DURATION_MS = 3000
const FADE_DURATION_MS = 700

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
  const [isLive, setIsLive] = useState(true)
  const [scrubMs, setScrubMs] = useState(0)
  const [timelineStartMs, setTimelineStartMs] = useState(0)
  const [timelineEndMs, setTimelineEndMs] = useState(0)
  const [allEvents, setAllEvents] = useState<TimelineEvent[]>([])

  const scheduled = useRef(new Map<string, ScheduledArrival>())
  const allEventsRef = useRef<TimelineEvent[]>([])
  const appStartMsRef = useRef(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const displayTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const runningRef = useRef(false)
  const isLiveRef = useRef(true)
  const lastPlayedKeyRef = useRef<string | null>(null)

  const triggerDisplay = useCallback((stationName: string, lineName: string) => {
    if (!isLiveRef.current) return
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
        })

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

        setTimelineEndMs(prev => Math.max(prev, realWorldMs))
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
    Tone.getTransport().start()
    runningRef.current = true
    appStartMsRef.current = Date.now()
    setTimelineStartMs(appStartMsRef.current)
    setScrubMs(Date.now())
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
  }, [pollStation])

  const stop = useCallback(() => {
    runningRef.current = false
    isLiveRef.current = true
    setIsLive(true)

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
    setTimelineStartMs(0)
    setTimelineEndMs(0)

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setDisplayItems([])
  }, [])

  // Live-time ticker: advance scrubMs to Date.now() every 500ms when in live mode
  useEffect(() => {
    if (!running || !isLive) return
    const id = setInterval(() => setScrubMs(Date.now()), 500)
    return () => clearInterval(id)
  }, [running, isLive])

  const seek = useCallback((ms: number) => {
    isLiveRef.current = false
    setIsLive(false)
    setScrubMs(ms)
    const nearest = findNearest(allEventsRef.current, ms)
    if (nearest) {
      setDisplayItems([{ id: 'seek', stationName: nearest.stationName, lineName: nearest.lineName, visible: true }])
      if (nearest.key !== lastPlayedKeyRef.current) {
        lastPlayedKeyRef.current = nearest.key
        playNow(resolveLineSoundConfig(nearest.lineConfig, tonality))
      }
    }
  }, [])

  const seekAndPlay = seek

  const goLive = useCallback(() => {
    isLiveRef.current = true
    setIsLive(true)
    setScrubMs(Date.now())
    lastPlayedKeyRef.current = null
    setDisplayItems([])
  }, [])

  useEffect(() => {
    const displayTimers = displayTimersRef.current
    const scheduledEvents = scheduled.current

    return () => {
      runningRef.current = false
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
  }, [])

  return {
    running,
    displayItems,
    start,
    stop,
    isLive,
    scrubMs,
    timelineStartMs,
    timelineEndMs,
    allEvents,
    seek,
    seekAndPlay,
    goLive,
  }
}
