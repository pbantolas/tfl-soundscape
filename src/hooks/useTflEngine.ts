import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchArrivals } from '../api/tfl'
import { scheduleArrival, cancelScheduled, cancelAll, disposeEffects, playNow, preloadSampler } from '../audio/engine'
import { resolveLineSoundConfig } from '../config/tonality'
import type { AppSoundConfig, ScheduledArrival, StationSoundConfig, TimelineEvent } from '../config/types'
import stationsConfig from '../config/stations.json'
import { applyTimelineWindow, getTimelineBounds } from '../lib/timelineBuffer'

const { stations, tonality } = stationsConfig as unknown as AppSoundConfig
const POLL_WINDOW_MS = 30_000
const PRELOAD_LOOKAHEAD_MS = 120_000
const BUFFER_HISTORY_MS = 180_000
const DISPLAY_DURATION_MS = 3000
const FADE_DURATION_MS = 700
const AUTO_PLAYBACK_RATE = 32
const PLAYBACK_START_LEAD_MS = 50
const SCHEDULE_UPDATE_THRESHOLD_S = 15
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
  return events.reduce((best, event) =>
    Math.abs(event.realWorldMs - ms) < Math.abs(best.realWorldMs - ms) ? event : best
  )
}

function findCrossedEvents(events: TimelineEvent[], fromMs: number, toMs: number): TimelineEvent[] {
  if (events.length === 0 || fromMs === toMs) return []

  if (toMs > fromMs) {
    return events.filter((event) => event.realWorldMs > fromMs && event.realWorldMs <= toMs)
  }

  return events
    .filter((event) => event.realWorldMs < fromMs && event.realWorldMs >= toMs)
    .reverse()
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
  const [hasBufferedEvents, setHasBufferedEvents] = useState(false)

  const scheduled = useRef(new Map<string, ScheduledArrival>())
  const allEventsRef = useRef<TimelineEvent[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const autoPlayRef = useRef<number | null>(null)
  const livePlayheadRef = useRef<number | null>(null)
  const displayTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const runningRef = useRef(false)
  const playbackModeRef = useRef<PlaybackMode>('live')
  const previewCursorMsRef = useRef<number | null>(null)
  const latestTimelineEndMsRef = useRef(0)
  const autoLoopStartMsRef = useRef(0)
  const autoLoopEndMsRef = useRef(0)
  const pendingLoopEndMsRef = useRef(0)
  const autoDirectionRef = useRef<1 | -1>(1)
  const autoPlayheadMsRef = useRef(0)
  const lastAutoTickMsRef = useRef(0)
  const playbackOriginMsRef = useRef<number | null>(null)
  const playbackStartedAtPerfMsRef = useRef<number | null>(null)
  const transportStartSecondsRef = useRef<number | null>(null)
  const audioReadyRef = useRef(false)

  const isLive = playbackMode === 'live'

  const setMode = useCallback((mode: PlaybackMode) => {
    playbackModeRef.current = mode
    setPlaybackMode(mode)
  }, [])

  const stopAutoPlayback = useCallback(() => {
    if (autoPlayRef.current !== null) {
      cancelAnimationFrame(autoPlayRef.current)
      autoPlayRef.current = null
    }
  }, [])

  const stopLivePlayhead = useCallback(() => {
    if (livePlayheadRef.current !== null) {
      cancelAnimationFrame(livePlayheadRef.current)
      livePlayheadRef.current = null
    }
  }, [])

  const clearPollTimeouts = useCallback(() => {
    pollTimeoutsRef.current.forEach(timeout => clearTimeout(timeout))
    pollTimeoutsRef.current.clear()
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

  const getCurrentPlaybackPositionMs = useCallback(() => {
    if (!runningRef.current) return Date.now()

    const playbackOriginMs = playbackOriginMsRef.current
    const playbackStartedAtPerfMs = playbackStartedAtPerfMsRef.current
    if (playbackOriginMs === null || playbackStartedAtPerfMs === null) {
      return Date.now()
    }

    return playbackOriginMs + Math.max(0, performance.now() - playbackStartedAtPerfMs)
  }, [])

  const getBufferWindow = useCallback(() => {
    const anchorMs = Date.now()
    return {
      minMs: anchorMs - BUFFER_HISTORY_MS,
      maxMs: anchorMs + PRELOAD_LOOKAHEAD_MS,
    }
  }, [])

  const syncPlaybackSchedule = useCallback((events: TimelineEvent[]) => {
    if (!runningRef.current) return

    const playbackOriginMs = playbackOriginMsRef.current
    const transportStartSeconds = transportStartSecondsRef.current
    if (playbackOriginMs === null || transportStartSeconds === null) return

    const playbackNowMs = getCurrentPlaybackPositionMs()
    const eventKeys = new Set(events.map(event => event.key))

    for (const [key, entry] of scheduled.current) {
      const isMissing = !eventKeys.has(key)
      const isStale = entry.expectedArrival < Tone.now() - 10
      if (!isMissing && !isStale) continue
      cancelScheduled(entry.eventId)
      scheduled.current.delete(key)
    }

    for (const event of events) {
      if (event.realWorldMs < playbackNowMs) continue

      const arrivalTime = transportStartSeconds + ((event.realWorldMs - playbackOriginMs) / 1000)
      const existing = scheduled.current.get(event.key)

      if (existing) {
        const timeUntilArrival = existing.expectedArrival - Tone.now()
        const timeDiff = Math.abs(arrivalTime - existing.expectedArrival)
        if (timeUntilArrival < 10 || timeDiff < SCHEDULE_UPDATE_THRESHOLD_S) continue
        cancelScheduled(existing.eventId)
        scheduled.current.delete(event.key)
      }

      const resolvedConfig = resolveLineSoundConfig(event.lineConfig, tonality)
      const eventId = scheduleArrival(
        resolvedConfig,
        arrivalTime,
        () => {
          triggerDisplay(event.stationName, event.lineName)
          scheduled.current.delete(event.key)
        },
        () => playbackModeRef.current === 'live',
      )

      scheduled.current.set(event.key, {
        predictionId: event.key,
        eventId,
        stationName: event.stationName,
        lineId: event.lineId,
        lineName: event.lineName,
        expectedArrival: arrivalTime,
        scheduledAt: Date.now(),
        realWorldMs: event.realWorldMs,
        lineConfig: event.lineConfig,
      })
    }
  }, [getCurrentPlaybackPositionMs, triggerDisplay])

  const retimePlayback = useCallback((startMs: number) => {
    const leadSeconds = PLAYBACK_START_LEAD_MS / 1000

    cancelAll()
    scheduled.current.clear()
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    Tone.getTransport().start()

    playbackOriginMsRef.current = startMs
    playbackStartedAtPerfMsRef.current = performance.now() + PLAYBACK_START_LEAD_MS
    transportStartSecondsRef.current = Tone.now() + leadSeconds
    autoLoopStartMsRef.current = startMs
    autoLoopEndMsRef.current = latestTimelineEndMsRef.current
    pendingLoopEndMsRef.current = latestTimelineEndMsRef.current
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = startMs
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = startMs
    setLoopEndMs(0)
    setScrubMs(startMs)

    syncPlaybackSchedule(allEventsRef.current)
  }, [syncPlaybackSchedule])

  const refreshTimelineState = useCallback((events: TimelineEvent[]) => {
    allEventsRef.current = events
    setAllEvents(events)
    setHasBufferedEvents(events.length > 0)

    const { startMs, endMs } = getTimelineBounds(events)
    latestTimelineEndMsRef.current = endMs
    setTimelineStartMs(startMs)
    setTimelineEndMs(endMs)

    if (playbackModeRef.current === 'autoPingPong') {
      pendingLoopEndMsRef.current = Math.max(pendingLoopEndMsRef.current, endMs)
    }

    if (!runningRef.current && playbackModeRef.current === 'live') {
      setScrubMs(startMs)
      autoPlayheadMsRef.current = startMs
      previewCursorMsRef.current = startMs || null
    }
  }, [])

  const previewAt = useCallback((ms: number, options?: { resetCursor?: boolean }) => {
    const previousMs = options?.resetCursor ? null : previewCursorMsRef.current
    setScrubMs(ms)
    autoPlayheadMsRef.current = ms

    const nearest = findNearest(allEventsRef.current, ms)
    if (nearest) {
      setDisplayItems([{ id: 'seek', stationName: nearest.stationName, lineName: nearest.lineName, visible: true }])
    } else {
      setDisplayItems([])
    }

    if (audioReadyRef.current && previousMs !== null) {
      for (const crossedEvent of findCrossedEvents(allEventsRef.current, previousMs, ms)) {
        playNow(resolveLineSoundConfig(crossedEvent.lineConfig, tonality))
      }
    }

    previewCursorMsRef.current = ms
  }, [])

  const pollStation = useCallback(async (station: StationSoundConfig) => {
    try {
      const predictions = await fetchArrivals(station.stationId)
      const fetchedAtMs = Date.now()

      const incomingEvents: TimelineEvent[] = predictions.flatMap((prediction) => {
        const lineConfig = station.lines[prediction.lineId]
        if (!lineConfig || prediction.timeToStation <= 0) return []

        return [{
          key: `${station.stationId}_${prediction.vehicleId}_${prediction.lineId}`,
          stationId: station.stationId,
          stationName: station.stationName,
          lineId: prediction.lineId,
          lineName: prediction.lineName,
          realWorldMs: fetchedAtMs + (prediction.timeToStation * 1000),
          lineConfig,
        }]
      })

      const { events, changed } = applyTimelineWindow(
        allEventsRef.current,
        incomingEvents,
        station.stationId,
        getBufferWindow(),
      )

      if (changed) {
        refreshTimelineState(events)
      }

      if (runningRef.current) {
        syncPlaybackSchedule(events)
      }
    } catch (err) {
      console.error(`Poll error for ${station.stationName}:`, err)
    }
  }, [getBufferWindow, refreshTimelineState, syncPlaybackSchedule])

  const queuePollCycle = useCallback(() => {
    const stagger = POLL_WINDOW_MS / stations.length

    stations.forEach((station, index) => {
      const timeout = setTimeout(() => {
        pollTimeoutsRef.current.delete(timeout)
        void pollStation(station)
      }, index * stagger)

      pollTimeoutsRef.current.add(timeout)
    })
  }, [pollStation])

  const start = useCallback(async () => {
    if (runningRef.current) return

    const playbackOriginMs = allEventsRef.current[0]?.realWorldMs
    if (!playbackOriginMs) return

    await Tone.start()
    audioReadyRef.current = true
    await Promise.all([...configuredEngines].map((engine) => preloadSampler(engine)))

    runningRef.current = true
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('live')
    setRunning(true)

    retimePlayback(playbackOriginMs)
  }, [retimePlayback, setMode, stopAutoPlayback, stopLivePlayhead])

  const stop = useCallback(() => {
    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('live')

    displayTimersRef.current.forEach(timer => clearTimeout(timer))
    displayTimersRef.current.clear()

    cancelAll()
    scheduled.current.clear()
    playbackOriginMsRef.current = null
    playbackStartedAtPerfMsRef.current = null
    transportStartSecondsRef.current = null
    autoLoopStartMsRef.current = 0
    autoLoopEndMsRef.current = 0
    pendingLoopEndMsRef.current = 0
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = 0
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = timelineStartMs || null

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setLoopEndMs(0)
    setDisplayItems([])
    setScrubMs(allEventsRef.current[0]?.realWorldMs ?? 0)
  }, [setMode, stopAutoPlayback, stopLivePlayhead, timelineStartMs])

  useEffect(() => {
    if (!running || !isLive) {
      stopLivePlayhead()
      return
    }

    const tick = () => {
      const nowMs = getCurrentPlaybackPositionMs()
      setScrubMs(nowMs)
      autoPlayheadMsRef.current = nowMs
      previewCursorMsRef.current = nowMs
      livePlayheadRef.current = requestAnimationFrame(tick)
    }

    livePlayheadRef.current = requestAnimationFrame(tick)
    return () => stopLivePlayhead()
  }, [getCurrentPlaybackPositionMs, isLive, running, stopLivePlayhead])

  const seekStart = useCallback((ms: number) => {
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('scrub')
    setLoopEndMs(0)
    previewAt(ms, { resetCursor: true })
  }, [previewAt, setMode, stopAutoPlayback, stopLivePlayhead])

  const seek = useCallback((ms: number) => {
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('scrub')
    setLoopEndMs(0)
    previewAt(ms)
  }, [previewAt, setMode, stopAutoPlayback, stopLivePlayhead])

  const seekAndPlay = seek

  const goLive = useCallback(() => {
    if (!runningRef.current) return

    stopAutoPlayback()
    stopLivePlayhead()
    setMode('live')
    const liveMs = Math.max(Date.now(), allEventsRef.current[0]?.realWorldMs ?? 0)
    retimePlayback(liveMs)
    setScrubMs(liveMs)
    autoPlayheadMsRef.current = liveMs
    previewCursorMsRef.current = liveMs || null
    setDisplayItems([])
  }, [retimePlayback, setMode, stopAutoPlayback, stopLivePlayhead])

  const startAutoPingPong = useCallback(() => {
    if (!runningRef.current) return

    const loopStart = timelineStartMs
    const loopEnd = latestTimelineEndMsRef.current
    const loopSpan = loopEnd - loopStart
    if (loopSpan <= 0) return

    stopAutoPlayback()
    stopLivePlayhead()
    setMode('autoPingPong')
    autoLoopStartMsRef.current = loopStart
    autoLoopEndMsRef.current = loopEnd
    pendingLoopEndMsRef.current = loopEnd
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = loopStart
    lastAutoTickMsRef.current = performance.now()
    previewCursorMsRef.current = loopStart
    setLoopEndMs(loopEnd)
    previewAt(loopStart)

    const tick = (frameNow: number) => {
      const activeLoopStart = autoLoopStartMsRef.current
      const activeLoopEnd = autoLoopEndMsRef.current
      if (activeLoopEnd <= activeLoopStart) {
        autoPlayRef.current = requestAnimationFrame(tick)
        return
      }

      const elapsedMs = frameNow - lastAutoTickMsRef.current
      lastAutoTickMsRef.current = frameNow

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
      autoPlayRef.current = requestAnimationFrame(tick)
    }

    autoPlayRef.current = requestAnimationFrame(tick)
  }, [previewAt, setMode, stopAutoPlayback, stopLivePlayhead, timelineStartMs])

  useEffect(() => {
    queuePollCycle()
    intervalRef.current = setInterval(queuePollCycle, POLL_WINDOW_MS)

    return () => {
      runningRef.current = false
      stopAutoPlayback()
      stopLivePlayhead()
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      clearPollTimeouts()
      displayTimersRef.current.forEach(timer => clearTimeout(timer))
      displayTimersRef.current.clear()
      cancelAll()
      scheduled.current.clear()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      disposeEffects()
    }
  }, [clearPollTimeouts, queuePollCycle, stopAutoPlayback, stopLivePlayhead])

  return {
    running,
    hasBufferedEvents,
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
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  }
}
