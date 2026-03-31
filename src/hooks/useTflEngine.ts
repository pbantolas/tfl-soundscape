import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchLineArrivals } from '../api/tfl'
import { cancelAll, disposeEffects, preloadSampler, setFilterFrequency, triggerNoteAtTime } from '../audio/engine'
import stationsConfig from '../config/stations.json'
import type { AppSoundConfig, LineRole, LineSoundConfig, ResolvedLineSoundConfig, TimelineEvent } from '../config/types'
import { buildEuclideanPattern } from '../lib/euclidean'
import { applyTimelineWindow, getTimelineBounds } from '../lib/timelineBuffer'

const { lines, lineColors, lineColorsLight } = stationsConfig as AppSoundConfig

const POLL_WINDOW_MS = 30_000
const PRELOAD_LOOKAHEAD_MS = 120_000
const BUFFER_HISTORY_MS = 180_000
const DISPLAY_DURATION_MS = 3000
const FADE_DURATION_MS = 700
const MAX_DISPLAY_ITEMS = 3
const DEFAULT_AUTO_PLAYBACK_RATE = 16
const BED_TEMPO_BPM = 60
const BED_STEP_INTERVAL = '8n'
const ENERGY_BUMP = 0.18
const PLAYBACK_START_LEAD_MS = 50

const configuredEngines = new Set(Object.values(lines).map((line) => line.synth))
const lineEntries = Object.entries(lines) as [string, LineSoundConfig][]

const BASELINE_ENERGY_BY_ROLE: Record<LineRole, number> = {
  anchor: 0.12,
  texture: 0.08,
  spark: 0.05,
}

const HIT_PROBABILITY_BY_ROLE: Record<LineRole, { floor: number; ceiling: number }> = {
  anchor: { floor: 0.35, ceiling: 0.9 },
  texture: { floor: 0.2, ceiling: 0.8 },
  spark: { floor: 0.12, ceiling: 0.72 },
}

const ENERGY_HALF_LIFE_MS = 12_000
const ENERGY_DECAY_PER_MS = Math.log(2) / ENERGY_HALF_LIFE_MS

type PlaybackMode = 'live' | 'scrub' | 'autoPingPong'

interface DisplayItem {
  id: string
  stationName: string
  lineName: string
  lineId: string
  direction: string
  visible: boolean
}

interface DisplayTimers {
  fadeOut: ReturnType<typeof setTimeout>
  remove: ReturnType<typeof setTimeout> | null
}

interface RuntimeLineState {
  config: LineSoundConfig
  pattern: boolean[]
  energy: number
  noteIndex: number
}

function formatStationName(stationName: string): string {
  return stationName.replace(/\s+Underground Station$/, '')
}

function findNearest(events: TimelineEvent[], ms: number): TimelineEvent | null {
  if (events.length === 0) return null
  return events.reduce((best, event) =>
    Math.abs(event.realWorldMs - ms) < Math.abs(best.realWorldMs - ms) ? event : best,
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

function toDisplayItem(event: TimelineEvent, suffix = ''): DisplayItem {
  return {
    id: `display-${event.key}-${event.realWorldMs}${suffix}`,
    stationName: event.stationName,
    lineName: event.lineName,
    lineId: event.lineId,
    direction: event.direction,
    visible: true,
  }
}

function isValidTimelinePosition(ms: number | null, startMs: number, endMs: number): ms is number {
  return ms !== null && ms >= startMs && ms <= endMs
}

function getBaselineEnergy(role: LineRole): number {
  return BASELINE_ENERGY_BY_ROLE[role]
}

function getHitProbability(role: LineRole, energy: number): number {
  const { floor, ceiling } = HIT_PROBABILITY_BY_ROLE[role]
  return floor + ((ceiling - floor) * Math.max(0, Math.min(1, energy)))
}

function decayEnergy(current: number, floor: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || current <= floor) return floor
  const next = floor + ((current - floor) * Math.exp(-ENERGY_DECAY_PER_MS * elapsedMs))
  return next < floor ? floor : next
}

function buildRuntimeLineStates(): Map<string, RuntimeLineState> {
  return new Map(lineEntries.map(([lineId, config]) => [lineId, {
    config,
    pattern: buildEuclideanPattern(config.patternSteps, config.patternHits, config.patternRotation),
    energy: getBaselineEnergy(config.role),
    noteIndex: 0,
  }]))
}

function createResolvedNote(config: LineSoundConfig, noteIndex: number): ResolvedLineSoundConfig {
  const safeIndex = config.notes.length === 0 ? 0 : noteIndex % config.notes.length
  return {
    synth: config.synth,
    note: config.notes[safeIndex] ?? config.notes[0] ?? 'B3',
    duration: config.duration,
    volume: config.volume,
  }
}

function debugPlayback(label: string, data: Record<string, unknown>) {
  const fields = Object.entries(data)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  console.debug(`[playback:${label}] ${fields}`)
}

export function useTflEngine() {
  const [running, setRunning] = useState(false)
  const [audioReady, setAudioReady] = useState(false)
  const [displayItems, setDisplayItems] = useState<DisplayItem[]>([])
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('live')
  const [autoRate, setAutoRate] = useState(DEFAULT_AUTO_PLAYBACK_RATE)
  const [scrubMs, setScrubMs] = useState(0)
  const [timelineStartMs, setTimelineStartMs] = useState(0)
  const [timelineEndMs, setTimelineEndMs] = useState(0)
  const [loopStartMs, setLoopStartMs] = useState(0)
  const [loopEndMs, setLoopEndMs] = useState(0)
  const [allEvents, setAllEvents] = useState<TimelineEvent[]>([])
  const [hasBufferedEvents, setHasBufferedEvents] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [lineEnergies, setLineEnergies] = useState<Record<string, number>>({})

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDarkMode(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const allEventsRef = useRef<TimelineEvent[]>([])
  const displayItemsRef = useRef<DisplayItem[]>([])
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
  const pendingLoopStartMsRef = useRef(0)
  const pendingLoopEndMsRef = useRef(0)
  const autoDirectionRef = useRef<1 | -1>(1)
  const autoRateRef = useRef(DEFAULT_AUTO_PLAYBACK_RATE)
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
  const lineStatesRef = useRef<Map<string, RuntimeLineState>>(buildRuntimeLineStates())
  const bedEventIdRef = useRef<number | null>(null)
  const lastEnergyUpdateMsRef = useRef<number | null>(null)
  const lastEnergyRenderMsRef = useRef<number>(0)
  const stepIndexRef = useRef(0)

  const isLiveMode = playbackMode === 'live'

  const resetLineStates = useCallback(() => {
    lineStatesRef.current = buildRuntimeLineStates()
    stepIndexRef.current = 0
    lastEnergyUpdateMsRef.current = null
  }, [])

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

  const appendDisplayItems = useCallback((items: DisplayItem[]) => {
    if (items.length === 0) return

    setDisplayItems(prev => {
      const nextItems = [...prev, ...items]
      const overflow = nextItems.slice(0, Math.max(0, nextItems.length - MAX_DISPLAY_ITEMS))

      overflow.forEach(item => clearDisplayTimer(item.id))

      const trimmedItems = nextItems.slice(-MAX_DISPLAY_ITEMS)
      displayItemsRef.current = trimmedItems
      return trimmedItems
    })
  }, [clearDisplayTimer])

  const replaceDisplayItems = useCallback((items: DisplayItem[]) => {
    setDisplayItems(prev => {
      prev.forEach(item => clearDisplayTimer(item.id))

      const trimmedItems = items.slice(-MAX_DISPLAY_ITEMS)
      displayItemsRef.current = trimmedItems
      return trimmedItems
    })
  }, [clearDisplayTimer])

  const triggerDisplay = useCallback((stationName: string, lineName: string, lineId: string, direction: string) => {
    const id = `display-${displayIdRef.current++}`
    appendDisplayItems([{ id, stationName, lineName, lineId, direction, visible: true }])

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
  }, [appendDisplayItems])

  const getCurrentPlaybackPositionMs = useCallback(() => {
    if (!runningRef.current) return previewCursorMsRef.current ?? Date.now()

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

  const stopBedLoop = useCallback(() => {
    if (bedEventIdRef.current !== null) {
      Tone.getTransport().clear(bedEventIdRef.current)
      bedEventIdRef.current = null
    }
  }, [])

  const decayAllLineEnergy = useCallback((targetMs: number) => {
    const lastUpdate = lastEnergyUpdateMsRef.current
    lastEnergyUpdateMsRef.current = targetMs
    if (lastUpdate === null) return

    const elapsedMs = Math.max(0, targetMs - lastUpdate)
    if (elapsedMs === 0) return

    for (const state of lineStatesRef.current.values()) {
      const floor = getBaselineEnergy(state.config.role)
      state.energy = decayEnergy(state.energy, floor, elapsedMs)
    }
  }, [])

  const flushEnergyDisplay = useCallback(() => {
    const now = performance.now()
    if (now - lastEnergyRenderMsRef.current < 100) return
    lastEnergyRenderMsRef.current = now
    const snapshot: Record<string, number> = {}
    let total = 0
    let count = 0
    for (const [lineId, state] of lineStatesRef.current) {
      snapshot[lineId] = state.energy
      total += state.energy
      count += 1
    }
    setLineEnergies(snapshot)
    if (count > 0 && audioReadyRef.current) {
      setFilterFrequency(total / count)
    }
  }, [])

  const applyEventEnergy = useCallback((events: TimelineEvent[], targetMs: number) => {
    decayAllLineEnergy(targetMs)
    if (events.length === 0) return

    const counts = new Map<string, number>()

    for (const event of events) {
      counts.set(event.lineId, (counts.get(event.lineId) ?? 0) + 1)
    }

    for (const [lineId, count] of counts) {
      const state = lineStatesRef.current.get(lineId)
      if (!state) continue
      state.energy = state.energy + (1 - state.energy) * ENERGY_BUMP * Math.log1p(count)
    }
  }, [decayAllLineEnergy])

  const startBedLoop = useCallback(() => {
    stopBedLoop()
    stepIndexRef.current = 0
    Tone.getTransport().bpm.value = BED_TEMPO_BPM

    bedEventIdRef.current = Tone.getTransport().scheduleRepeat((time) => {
      const stepIndex = stepIndexRef.current

      for (const state of lineStatesRef.current.values()) {
        const pattern = state.pattern
        if (!pattern[stepIndex % pattern.length]) continue

        const probability = getHitProbability(state.config.role, state.energy)
        if (Math.random() > probability) continue

        const noteConfig = createResolvedNote(state.config, state.noteIndex)
        if (triggerNoteAtTime(noteConfig, time) && state.config.notes.length > 0) {
          state.noteIndex = (state.noteIndex + 1) % state.config.notes.length
        }
      }

      stepIndexRef.current = (stepIndex + 1) % 16
    }, BED_STEP_INTERVAL, 0)
  }, [stopBedLoop])

  const startTransport = useCallback((startMs: number) => {
    const leadSeconds = PLAYBACK_START_LEAD_MS / 1000

    debugPlayback('start-transport', {
      mode: playbackModeRef.current,
      startMs,
      timelineStart: allEventsRef.current[0]?.realWorldMs ?? 0,
      timelineEnd: latestTimelineEndMsRef.current,
      scrubMs: previewCursorMsRef.current ?? 'null',
      autoPlayhead: autoPlayheadMsRef.current,
      loopStart: autoLoopStartMsRef.current,
      loopEnd: autoLoopEndMsRef.current,
    })

    cancelAll()
    stopBedLoop()
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    Tone.getTransport().seconds = 0
    Tone.getTransport().start()

    resetLineStates()
    playbackOriginMsRef.current = startMs
    playbackStartedAtPerfMsRef.current = performance.now() + PLAYBACK_START_LEAD_MS
    transportStartSecondsRef.current = leadSeconds
    autoLoopStartMsRef.current = startMs
    autoLoopEndMsRef.current = latestTimelineEndMsRef.current
    pendingLoopStartMsRef.current = startMs
    pendingLoopEndMsRef.current = latestTimelineEndMsRef.current
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = startMs
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = startMs
    setLoopStartMs(0)
    setLoopEndMs(0)
    setScrubMs(startMs)
    startBedLoop()
  }, [resetLineStates, startBedLoop, stopBedLoop])

  const refreshTimelineState = useCallback((events: TimelineEvent[]) => {
    allEventsRef.current = events
    setAllEvents(events)
    setHasBufferedEvents(events.length > 0)

    const { startMs, endMs } = getTimelineBounds(events)
    latestTimelineEndMsRef.current = endMs
    setTimelineStartMs(startMs)
    setTimelineEndMs(endMs)

    if (playbackModeRef.current === 'autoPingPong') {
      debugPlayback('refresh-auto-window', {
        startMs,
        endMs,
        autoPlayhead: autoPlayheadMsRef.current,
        previewCursor: previewCursorMsRef.current ?? 'null',
        scrubMs: previewCursorMsRef.current ?? 'null',
      })
      pendingLoopStartMsRef.current = startMs
      pendingLoopEndMsRef.current = Math.max(pendingLoopEndMsRef.current, endMs)
    }

    if (playbackModeRef.current !== 'live' && startMs > 0 && autoPlayheadMsRef.current < startMs) {
      debugPlayback('refresh-clamp-playhead', {
        mode: playbackModeRef.current,
        startMs,
        endMs,
        autoPlayheadBefore: autoPlayheadMsRef.current,
        previewCursorBefore: previewCursorMsRef.current ?? 'null',
        scrubMsBefore: previewCursorMsRef.current ?? 'null',
      })
      autoPlayheadMsRef.current = startMs
      previewCursorMsRef.current = startMs
      setScrubMs(startMs)
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

    const crossedEvents = previousMs === null
      ? []
      : findCrossedEvents(allEventsRef.current, previousMs, ms)

    if (crossedEvents.length > 0) {
      appendDisplayItems(crossedEvents.map((event, index) => toDisplayItem(event, `-${ms}-${index}`)))
      if (audioReadyRef.current) {
        applyEventEnergy(crossedEvents, ms)
      }
    } else if (previousMs === null || displayItemsRef.current.length === 0) {
      const nearest = findNearest(allEventsRef.current, ms)
      replaceDisplayItems(nearest ? [toDisplayItem(nearest)] : [])
      if (audioReadyRef.current) {
        decayAllLineEnergy(ms)
      }
    } else if (audioReadyRef.current) {
      decayAllLineEnergy(ms)
    }

    previewCursorMsRef.current = ms
  }, [appendDisplayItems, applyEventEnergy, decayAllLineEnergy, replaceDisplayItems])

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

      const incomingEvents: TimelineEvent[] = predictions.flatMap((prediction) => {
        if (prediction.timeToStation <= 0) return []
        if (lineConfig.stationIds && !lineConfig.stationIds.includes(prediction.naptanId)) return []

        return [{
          key: `${prediction.naptanId}_${prediction.vehicleId}_${lineId}`,
          stationId: prediction.naptanId,
          stationName: formatStationName(prediction.stationName),
          lineId,
          lineName: prediction.lineName,
          direction: prediction.direction,
          realWorldMs: fetchedAtMs + (prediction.timeToStation * 1000),
          lineConfig,
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
    } catch (err) {
      console.error(`Poll error for line ${lineId}:`, err)
    }
  }, [getBufferWindow, refreshTimelineState])

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

    startTransport(playbackOriginMs)
  }, [ensureAudioReady, setMode, startTransport, stopAutoPlayback, stopLivePlayhead])

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
    stopBedLoop()
    playbackOriginMsRef.current = null
    playbackStartedAtPerfMsRef.current = null
    transportStartSecondsRef.current = null
    autoLoopStartMsRef.current = 0
    autoLoopEndMsRef.current = 0
    pendingLoopStartMsRef.current = 0
    pendingLoopEndMsRef.current = 0
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = stoppedAtMs
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = stoppedAtMs || timelineStartMs || null

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setLoopStartMs(0)
    setLoopEndMs(0)
    displayItemsRef.current = []
    setDisplayItems([])
    setScrubMs(stoppedAtMs)
  }, [clearAllDisplayTimers, getCurrentPlaybackPositionMs, setMode, stopAutoPlayback, stopBedLoop, stopLivePlayhead, timelineStartMs])

  useEffect(() => {
    if (!running || !isLiveMode) {
      stopLivePlayhead()
      return
    }

    const tick = () => {
      const nowMs = getCurrentPlaybackPositionMs()
      const previousMs = previewCursorMsRef.current

      setScrubMs(nowMs)
      autoPlayheadMsRef.current = nowMs

      if (audioReadyRef.current && previousMs !== null) {
        const crossedEvents = findCrossedEvents(allEventsRef.current, previousMs, nowMs)
        if (crossedEvents.length > 0) {
          crossedEvents.forEach((event) => {
            triggerDisplay(event.stationName, event.lineName, event.lineId, event.direction)
          })
        }
        applyEventEnergy(crossedEvents, nowMs)
      } else if (audioReadyRef.current) {
        decayAllLineEnergy(nowMs)
      }

      previewCursorMsRef.current = nowMs
      flushEnergyDisplay()
      livePlayheadRef.current = requestAnimationFrame(tick)
    }

    livePlayheadRef.current = requestAnimationFrame(tick)
    return () => stopLivePlayhead()
  }, [applyEventEnergy, decayAllLineEnergy, flushEnergyDisplay, getCurrentPlaybackPositionMs, isLiveMode, running, stopLivePlayhead, triggerDisplay])

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
    startTransport(ms)
    previewAt(ms, { resetCursor: true })
  }, [ensureAudioReady, previewAt, setMode, startTransport, stopAutoPlayback, stopLivePlayhead])

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
    startTransport(liveMs)
    setRunning(true)
    setScrubMs(liveMs)
    autoPlayheadMsRef.current = liveMs
    previewCursorMsRef.current = liveMs || null
    displayItemsRef.current = []
    setDisplayItems([])
  }, [ensureAudioReady, setMode, startTransport, stopAutoPlayback, stopLivePlayhead])

  const startAutoPingPong = useCallback(async (rate: number = DEFAULT_AUTO_PLAYBACK_RATE) => {
    const loopStart = timelineStartMs
    const loopEnd = latestTimelineEndMsRef.current
    const loopSpan = loopEnd - loopStart
    if (loopSpan <= 0) return
    const requestedStartMs = isValidTimelinePosition(previewCursorMsRef.current, loopStart, loopEnd)
      ? previewCursorMsRef.current
      : (runningRef.current ? getCurrentPlaybackPositionMs() : null)

    debugPlayback('auto-start-request', {
      rate,
      loopStart,
      loopEnd,
      currentScrubMs: scrubMs,
      currentPreviewCursor: previewCursorMsRef.current ?? 'null',
      currentAutoPlayhead: autoPlayheadMsRef.current,
      running: runningRef.current,
      mode: playbackModeRef.current,
    })

    scrubRequestIdRef.current += 1

    await ensureAudioReady({ preload: true })

    const startMs = isValidTimelinePosition(requestedStartMs, loopStart, loopEnd)
      ? requestedStartMs
      : loopStart

    runningRef.current = false
    stopAutoPlayback()
    stopLivePlayhead()
    setMode('autoPingPong')
    setRunning(false)
    autoRateRef.current = rate
    setAutoRate(rate)
    autoLoopStartMsRef.current = loopStart
    autoLoopEndMsRef.current = loopEnd
    pendingLoopStartMsRef.current = loopStart
    pendingLoopEndMsRef.current = loopEnd
    autoDirectionRef.current = 1
    autoPlayheadMsRef.current = startMs
    lastAutoTickMsRef.current = 0
    previewCursorMsRef.current = startMs
    setLoopStartMs(loopStart)
    setLoopEndMs(loopEnd)
    startTransport(startMs)
    autoLoopStartMsRef.current = loopStart
    autoLoopEndMsRef.current = loopEnd
    pendingLoopStartMsRef.current = loopStart
    pendingLoopEndMsRef.current = loopEnd
    debugPlayback('auto-start-applied', {
      startMs,
      loopStart,
      loopEnd,
      scrubMs,
      previewCursor: previewCursorMsRef.current ?? 'null',
      autoPlayhead: autoPlayheadMsRef.current,
    })
    previewAt(startMs, { resetCursor: true })

    const tick = (frameNow: number) => {
      const activeLoopStart = autoLoopStartMsRef.current
      const activeLoopEnd = autoLoopEndMsRef.current
      if (activeLoopEnd <= activeLoopStart) {
        autoPlayRef.current = requestAnimationFrame(tick)
        return
      }

      if (lastAutoTickMsRef.current === 0) {
        lastAutoTickMsRef.current = frameNow
        autoPlayRef.current = requestAnimationFrame(tick)
        return
      }

      const elapsedMs = frameNow - lastAutoTickMsRef.current
      lastAutoTickMsRef.current = frameNow

      let nextMs = autoPlayheadMsRef.current + elapsedMs * autoRateRef.current * autoDirectionRef.current
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
        const nextLoopStart = pendingLoopStartMsRef.current
        const nextLoopEnd = Math.max(pendingLoopEndMsRef.current, nextLoopStart)
        debugPlayback('auto-loop-restart', {
          nextLoopStart,
          nextLoopEnd,
          nextMs,
          previousLoopStart: autoLoopStartMsRef.current,
          previousLoopEnd: autoLoopEndMsRef.current,
        })
        autoLoopStartMsRef.current = nextLoopStart
        autoLoopEndMsRef.current = nextLoopEnd
        autoPlayheadMsRef.current = Math.max(nextMs, nextLoopStart)
        setLoopStartMs(nextLoopStart)
        setLoopEndMs(nextLoopEnd)
      }

      previewAt(autoPlayheadMsRef.current)
      flushEnergyDisplay()
      autoPlayRef.current = requestAnimationFrame(tick)
    }

    autoPlayRef.current = requestAnimationFrame(tick)
  }, [ensureAudioReady, flushEnergyDisplay, getCurrentPlaybackPositionMs, previewAt, setMode, startTransport, stopAutoPlayback, stopLivePlayhead, timelineStartMs])

  useEffect(() => {
    queuePollCycle()
    intervalRef.current = setInterval(queuePollCycle, POLL_WINDOW_MS)

    return () => {
      runningRef.current = false
      stopAutoPlayback()
      stopLivePlayhead()
      stopBedLoop()
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      clearPollTimeouts()
      clearAllDisplayTimers()
      cancelAll()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      disposeEffects()
    }
  }, [clearAllDisplayTimers, clearPollTimeouts, queuePollCycle, stopAutoPlayback, stopBedLoop, stopLivePlayhead])

  return {
    running,
    audioReady,
    hasBufferedEvents,
    displayItems,
    start,
    stop,
    playbackMode,
    autoRate,
    isLive: running && isLiveMode,
    scrubMs,
    timelineStartMs,
    timelineEndMs,
    loopStartMs,
    loopEndMs,
    allEvents,
    lineColors: isDarkMode ? lineColors : lineColorsLight,
    lineEnergies,
    seek,
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  }
}
