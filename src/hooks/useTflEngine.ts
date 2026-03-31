import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchLineArrivals } from '../api/tfl'
import { scheduleArrival, cancelScheduled, cancelAll, disposeEffects, getAudioDebugSnapshot, playNow, preloadSampler } from '../audio/engine'
import { resolveLineSoundConfig } from '../config/tonality'
import type { AppSoundConfig, LineSoundConfig, ScheduledArrival, TimelineEvent } from '../config/types'
import stationsConfig from '../config/stations.json'
import { applyTimelineWindow, getTimelineBounds } from '../lib/timelineBuffer'

const { lines, tonality, lineColors } = stationsConfig as unknown as AppSoundConfig
const POLL_WINDOW_MS = 30_000
const PRELOAD_LOOKAHEAD_MS = 120_000
const BUFFER_HISTORY_MS = 180_000
const DISPLAY_DURATION_MS = 3000
const FADE_DURATION_MS = 700
const MAX_DISPLAY_ITEMS = 3
const AUTO_PLAYBACK_RATE = 32
const PLAYBACK_START_LEAD_MS = 50
const SCHEDULE_UPDATE_THRESHOLD_S = 15
const MAX_PREVIEW_EVENTS_PER_STEP = 2
const configuredEngines = new Set(Object.values(lines).map((line) => line.synth))
const lineEntries = Object.entries(lines) as [string, LineSoundConfig][]

type PlaybackMode = 'live' | 'scrub' | 'autoPingPong'

interface DisplayItem {
  id: string
  stationName: string
  lineName: string
  lineId: string
  visible: boolean
}

interface DisplayTimers {
  fadeOut: ReturnType<typeof setTimeout>
  remove: ReturnType<typeof setTimeout> | null
}

function formatStationName(stationName: string): string {
  return stationName.replace(/\s+Underground Station$/, '')
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

function selectPreviewEvents(events: TimelineEvent[]): TimelineEvent[] {
  if (events.length <= MAX_PREVIEW_EVENTS_PER_STEP) return events
  return events.slice(-MAX_PREVIEW_EVENTS_PER_STEP)
}

function isValidTimelinePosition(ms: number | null, startMs: number, endMs: number): ms is number {
  return ms !== null && ms >= startMs && ms <= endMs
}

export function useTflEngine() {
  const [running, setRunning] = useState(false)
  const [audioReady, setAudioReady] = useState(false)
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
  const displayTimersRef = useRef(new Map<string, DisplayTimers>())
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
  const audioUnlockPromiseRef = useRef<Promise<void> | null>(null)
  const audioPreloadPromiseRef = useRef<Promise<void> | null>(null)
  const scrubRequestIdRef = useRef(0)
  const displayIdRef = useRef(0)

  const isLiveMode = playbackMode === 'live'

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

  const clearDisplayTimer = useCallback((id: string) => {
    const timers = displayTimersRef.current.get(id)
    if (!timers) return

    clearTimeout(timers.fadeOut)
    if (timers.remove) {
      clearTimeout(timers.remove)
    }

    displayTimersRef.current.delete(id)
  }, [])

  const clearAllDisplayTimers = useCallback(() => {
    displayTimersRef.current.forEach((timers) => {
      clearTimeout(timers.fadeOut)
      if (timers.remove) {
        clearTimeout(timers.remove)
      }
    })
    displayTimersRef.current.clear()
  }, [])

  const triggerDisplay = useCallback((stationName: string, lineName: string, lineId: string) => {
    if (playbackModeRef.current !== 'live') return
    const id = `display-${displayIdRef.current++}`
    setDisplayItems(prev => {
      const nextItems = [...prev, { id, stationName, lineName, lineId, visible: true }]
      const overflow = nextItems.slice(0, Math.max(0, nextItems.length - MAX_DISPLAY_ITEMS))

      overflow.forEach(item => clearDisplayTimer(item.id))

      return nextItems.slice(-MAX_DISPLAY_ITEMS)
    })

    const fadeOut = setTimeout(() => {
      const timers = displayTimersRef.current.get(id)
      if (!timers) return

      setDisplayItems(prev => prev.map(item => item.id === id ? { ...item, visible: false } : item))

      const remove = setTimeout(() => {
        displayTimersRef.current.delete(id)
        setDisplayItems(prev => prev.filter(item => item.id !== id))
      }, FADE_DURATION_MS)

      displayTimersRef.current.set(id, { ...timers, remove })
    }, DISPLAY_DURATION_MS)

    displayTimersRef.current.set(id, { fadeOut, remove: null })
  }, [clearDisplayTimer])

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
      const isStale = entry.expectedArrival < Tone.getTransport().seconds - 10
      if (!isMissing && !isStale) continue
      cancelScheduled(entry.eventId)
      scheduled.current.delete(key)
    }

    for (const event of events) {
      if (event.realWorldMs < playbackNowMs) continue

      const arrivalTime = transportStartSeconds + ((event.realWorldMs - playbackOriginMs) / 1000)
      const existing = scheduled.current.get(event.key)

      if (existing) {
        const timeUntilArrival = existing.expectedArrival - Tone.getTransport().seconds
        const timeDiff = Math.abs(arrivalTime - existing.expectedArrival)
        if (timeUntilArrival < 10 || timeDiff < SCHEDULE_UPDATE_THRESHOLD_S) continue
        cancelScheduled(existing.eventId)
        scheduled.current.delete(event.key)
      }

      const eventId = scheduleArrival(
        event.lineConfig,
        arrivalTime,
        () => {
          triggerDisplay(event.stationName, event.lineName, event.lineId)
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
    Tone.getTransport().seconds = 0
    Tone.getTransport().start()

    playbackOriginMsRef.current = startMs
    playbackStartedAtPerfMsRef.current = performance.now() + PLAYBACK_START_LEAD_MS
    transportStartSecondsRef.current = leadSeconds
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
      setDisplayItems([{ id: 'seek', stationName: nearest.stationName, lineName: nearest.lineName, lineId: nearest.lineId, visible: true }])
    } else {
      setDisplayItems([])
    }

    if (audioReadyRef.current && previousMs !== null) {
      const crossedEvents = findCrossedEvents(allEventsRef.current, previousMs, ms)
      const previewEvents = selectPreviewEvents(crossedEvents)
      if (crossedEvents.length > 1) {
        const snapshot = getAudioDebugSnapshot()
        console.debug(
          `[audio:scrub] crossed=${crossedEvents.length} played=${previewEvents.length} skipped=${crossedEvents.length - previewEvents.length} queue=${snapshot.queue} samplerVoices=${snapshot.samplerVoices} droppedTotal=${snapshot.droppedTotal}`,
        )
      }

      for (const crossedEvent of previewEvents) {
        playNow(crossedEvent.lineConfig)
      }
    }

    previewCursorMsRef.current = ms
  }, [])

  const ensureAudioUnlocked = useCallback(async () => {
    if (audioReadyRef.current) return

    if (!audioUnlockPromiseRef.current) {
      audioUnlockPromiseRef.current = Tone.start().then(() => {
        audioReadyRef.current = true
        setAudioReady(true)
      })
    }

    await audioUnlockPromiseRef.current
  }, [])

  const preloadAudioEngines = useCallback(async () => {
    if (!audioPreloadPromiseRef.current) {
      audioPreloadPromiseRef.current = Promise
        .all([...configuredEngines].map((engine) => preloadSampler(engine)))
        .then(() => undefined)
    }

    await audioPreloadPromiseRef.current
  }, [])

  const ensureAudioReady = useCallback(async (options?: { preload?: boolean }) => {
    await ensureAudioUnlocked()
    if (options?.preload) {
      await preloadAudioEngines()
    }
  }, [ensureAudioUnlocked, preloadAudioEngines])

  const pollLine = useCallback(async (lineId: string, lineConfig: LineSoundConfig) => {
    try {
      const predictions = await fetchLineArrivals(lineId)
      const fetchedAtMs = Date.now()
      const existingEventsByKey = new Map(
        allEventsRef.current
          .filter((event) => event.lineId === lineId)
          .map((event) => [event.key, event]),
      )

      const incomingEvents: TimelineEvent[] = predictions.flatMap((prediction) => {
        if (prediction.timeToStation <= 0) return []
        if (lineConfig.stationIds && !lineConfig.stationIds.includes(prediction.naptanId)) return []

        const key = `${prediction.naptanId}_${prediction.vehicleId}_${lineId}`
        const existingEvent = existingEventsByKey.get(key)

        return [{
          key,
          stationId: prediction.naptanId,
          stationName: formatStationName(prediction.stationName),
          lineId,
          lineName: prediction.lineName,
          realWorldMs: fetchedAtMs + (prediction.timeToStation * 1000),
          lineConfig: existingEvent?.lineConfig ?? resolveLineSoundConfig(lineConfig, tonality),
        }]
      })

      const { events, changed } = applyTimelineWindow(
        allEventsRef.current,
        incomingEvents,
        lineId,
        getBufferWindow(),
      )

      if (changed) {
        refreshTimelineState(events)
      }

      if (runningRef.current) {
        syncPlaybackSchedule(events)
      }
    } catch (err) {
      console.error(`Poll error for line ${lineId}:`, err)
    }
  }, [getBufferWindow, refreshTimelineState, syncPlaybackSchedule])

  const queuePollCycle = useCallback(() => {
    const stagger = POLL_WINDOW_MS / lineEntries.length

    lineEntries.forEach(([lineId, lineConfig], index) => {
      const timeout = setTimeout(() => {
        pollTimeoutsRef.current.delete(timeout)
        void pollLine(lineId, lineConfig)
      }, index * stagger)

      pollTimeoutsRef.current.add(timeout)
    })
  }, [pollLine])

  const start = useCallback(async () => {
    const timelineStart = allEventsRef.current[0]?.realWorldMs ?? 0
    const timelineEnd = latestTimelineEndMsRef.current
    const playbackOriginMs = isValidTimelinePosition(previewCursorMsRef.current, timelineStart, timelineEnd)
      ? previewCursorMsRef.current
      : timelineStart
    if (!playbackOriginMs) return

    await ensureAudioReady({ preload: true })

    runningRef.current = true
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('live')
    setRunning(true)

    retimePlayback(playbackOriginMs)
  }, [ensureAudioReady, retimePlayback, setMode, stopAutoPlayback, stopLivePlayhead])

  const stop = useCallback(() => {
    const stoppedAtMs = runningRef.current
      ? getCurrentPlaybackPositionMs()
      : (previewCursorMsRef.current ?? allEventsRef.current[0]?.realWorldMs ?? 0)

    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('scrub')

    clearAllDisplayTimers()

    cancelAll()
    scheduled.current.clear()
    playbackOriginMsRef.current = null
    playbackStartedAtPerfMsRef.current = null
    transportStartSecondsRef.current = null
    autoLoopStartMsRef.current = 0
    autoLoopEndMsRef.current = 0
    pendingLoopEndMsRef.current = 0
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = stoppedAtMs
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = stoppedAtMs || timelineStartMs || null

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setLoopEndMs(0)
    setDisplayItems([])
    setScrubMs(stoppedAtMs)
  }, [clearAllDisplayTimers, getCurrentPlaybackPositionMs, setMode, stopAutoPlayback, stopLivePlayhead, timelineStartMs])

  useEffect(() => {
    if (!running || !isLiveMode) {
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
  }, [getCurrentPlaybackPositionMs, isLiveMode, running, stopLivePlayhead])

  const seekStart = useCallback(async (ms: number) => {
    if (allEventsRef.current.length === 0) return

    const requestId = ++scrubRequestIdRef.current

    await ensureAudioReady({ preload: true })
    if (requestId !== scrubRequestIdRef.current) return

    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('scrub')
    setRunning(false)
    setLoopEndMs(0)
    previewAt(ms, { resetCursor: true })
  }, [ensureAudioReady, previewAt, setMode, stopAutoPlayback, stopLivePlayhead])

  const seek = useCallback(async (ms: number) => {
    if (allEventsRef.current.length === 0) return

    const requestId = ++scrubRequestIdRef.current

    await ensureAudioReady({ preload: true })
    if (requestId !== scrubRequestIdRef.current) return

    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('scrub')
    setRunning(false)
    setLoopEndMs(0)
    previewAt(ms)
  }, [ensureAudioReady, previewAt, setMode, stopAutoPlayback, stopLivePlayhead])

  const seekAndPlay = seek

  const goLive = useCallback(async () => {
    const liveMs = Math.max(Date.now(), allEventsRef.current[0]?.realWorldMs ?? 0)
    if (!liveMs) return

    scrubRequestIdRef.current += 1

    await ensureAudioReady({ preload: true })

    runningRef.current = true
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('live')
    retimePlayback(liveMs)
    setRunning(true)
    setScrubMs(liveMs)
    autoPlayheadMsRef.current = liveMs
    previewCursorMsRef.current = liveMs || null
    setDisplayItems([])
  }, [ensureAudioReady, retimePlayback, setMode, stopAutoPlayback, stopLivePlayhead])

  const startAutoPingPong = useCallback(async () => {
    const loopStart = timelineStartMs
    const loopEnd = latestTimelineEndMsRef.current
    const loopSpan = loopEnd - loopStart
    if (loopSpan <= 0) return

    scrubRequestIdRef.current += 1

    await ensureAudioReady({ preload: true })

    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('autoPingPong')
    setRunning(false)
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
  }, [ensureAudioReady, previewAt, setMode, stopAutoPlayback, stopLivePlayhead, timelineStartMs])

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
      clearAllDisplayTimers()
      cancelAll()
      scheduled.current.clear()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      disposeEffects()
    }
  }, [clearAllDisplayTimers, clearPollTimeouts, queuePollCycle, stopAutoPlayback, stopLivePlayhead])

  return {
    running,
    audioReady,
    hasBufferedEvents,
    displayItems,
    start,
    stop,
    playbackMode,
    autoRate: AUTO_PLAYBACK_RATE,
    isLive: running && isLiveMode,
    scrubMs,
    timelineStartMs,
    timelineEndMs,
    loopEndMs,
    allEvents,
    lineColors,
    seek,
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  }
}
