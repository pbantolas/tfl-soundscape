import * as Tone from 'tone'
import type { ResolvedLineSoundConfig } from '../config/types'

const RELEASE = 2.5
const FADEOUT_S = 0.05
const PIANO_RELEASE = 1.8

const pianoSampleUrls = {
  E2: 'E2.mp3',
  G2: 'G2.mp3',
  B2: 'B2.mp3',
  D3: 'D3.mp3',
  F3: 'F3.mp3',
  A3: 'A3.mp3',
  C4: 'C4.mp3',
  E4: 'E4.mp3',
  G4: 'G4.mp3',
  B4: 'B4.mp3',
} as const

const duoVoice = {
  oscillator: { type: 'triangle' as const },
  envelope: { attack: 0.4, decay: 0.3, sustain: 0.7, release: RELEASE },
  filter: { Q: 1, type: 'lowpass' as const, rolloff: -12 as const },
  filterEnvelope: { attack: 0.5, baseFrequency: 600, exponent: 2, decay: 0.3, sustain: 0.7, release: RELEASE },
}

const synthFactories: Record<string, () => Tone.DuoSynth | Tone.PluckSynth> = {
  DuoSynth:   () => new Tone.DuoSynth({ harmonicity: 1.005, vibratoRate: 0.4, vibratoAmount: 0.08, voice0: duoVoice, voice1: duoVoice }),
  PluckSynth: () => new Tone.PluckSynth({ attackNoise: 1, dampening: 3500, resonance: 0.97 }),
}

const maxVoicesBySynth = {
  DuoSynth: 8,
  PluckSynth: 10,
} as const

type SynthKind = keyof typeof maxVoicesBySynth
type SynthVoice = Tone.DuoSynth | Tone.PluckSynth
type EngineKind = SynthKind | 'PianoSampler'

interface VoiceSlot {
  kind: SynthKind
  synth: SynthVoice
  state: 'idle' | 'active'
  token: number
  busyUntil: number
  lastStart: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface ActiveEventHandle {
  kind: 'synth' | 'sampler'
}

interface ActiveSynthEventHandle extends ActiveEventHandle {
  kind: 'synth'
  slot: VoiceSlot
  token: number
}

interface ActiveSamplerEventHandle extends ActiveEventHandle {
  kind: 'sampler'
  note: string
  idleTimer: ReturnType<typeof setTimeout> | null
}

type EngineEvent = {
  kind: 'note'
  config: ResolvedLineSoundConfig
}

type ShouldTrigger = () => boolean

let reverb: Tone.Reverb | null = null
let filter: Tone.Filter | null = null
let limiter: Tone.Limiter | null = null
let pianoSampler: Tone.Sampler | null = null
let pianoSamplerLoadPromise: Promise<Tone.Sampler> | null = null
let pianoSamplerLoadVersion = 0
const voicePools = new Map<SynthKind, VoiceSlot[]>()
const activeEvents = new Map<number, ActiveSynthEventHandle | ActiveSamplerEventHandle>()
let nextImmediateEventId = -1
const pendingPreviewTimeouts = new Map<number, ReturnType<typeof setTimeout>>()
let droppedPreviewCount = 0

let _lastCtxState = ''

function checkCtxState() {
  const state = Tone.getContext().rawContext?.state ?? 'unknown'
  if (state !== _lastCtxState) {
    console.warn(`[audio:context] state changed: ${_lastCtxState || '(init)'} → ${state}`)
    _lastCtxState = state
  }
}

function getFilter(): Tone.Filter {
  checkCtxState()
  if (!limiter) {
    limiter = new Tone.Limiter(-4).toDestination()
  }
  if (!reverb) {
    reverb = new Tone.Reverb({ decay: 12, preDelay: 0.05, wet: 0.8 }).connect(limiter)
    reverb.generate()
  }
  if (!filter) {
    filter = new Tone.Filter({ frequency: 5000, type: 'lowpass', rolloff: -12 }).connect(reverb)
  }
  return filter
}

function createPianoSampler(): Promise<Tone.Sampler> {
  if (pianoSampler) return Promise.resolve(pianoSampler)
  if (pianoSamplerLoadPromise) return pianoSamplerLoadPromise

  const loadVersion = ++pianoSamplerLoadVersion
  pianoSamplerLoadPromise = new Promise((resolve) => {
    const sampler = new Tone.Sampler({
      urls: pianoSampleUrls,
      baseUrl: '/samples/piano/',
      release: PIANO_RELEASE,
      attack: 0.005,
      onload: () => {
        if (loadVersion !== pianoSamplerLoadVersion) {
          sampler.dispose()
          resolve(sampler)
          return
        }
        pianoSampler = sampler
        pianoSamplerLoadPromise = null
        resolve(sampler)
      },
    }).connect(getFilter())
  })

  return pianoSamplerLoadPromise
}

function getLoadedPianoSampler(): Tone.Sampler | null {
  return pianoSampler?.loaded ? pianoSampler : null
}

export function preloadSampler(engine: string): Promise<void> {
  if (engine !== 'PianoSampler') return Promise.resolve()
  return createPianoSampler().then(() => undefined)
}

// Transport event IDs that haven't fired yet (no voice lease exists)
const pendingIds = new Set<number>()
const previewIds: number[] = []

function normalizeSynthKind(synth: string): SynthKind {
  return synth in synthFactories ? synth as SynthKind : 'DuoSynth'
}

function getEngineKind(engine: string): EngineKind {
  return engine === 'PianoSampler' ? 'PianoSampler' : normalizeSynthKind(engine)
}

function getPool(kind: SynthKind): VoiceSlot[] {
  let pool = voicePools.get(kind)
  if (!pool) {
    pool = []
    voicePools.set(kind, pool)
  }
  return pool
}

function createVoiceSlot(kind: SynthKind): VoiceSlot {
  const synth = synthFactories[kind]().connect(getFilter())
  return {
    kind,
    synth,
    state: 'idle',
    token: 0,
    busyUntil: 0,
    lastStart: 0,
    idleTimer: null,
  }
}

function clearIdleTimer(slot: VoiceSlot) {
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer)
    slot.idleTimer = null
  }
}

function activeVoiceCount(): number {
  let count = 0
  for (const pool of voicePools.values()) {
    count += pool.filter((slot) => slot.state === 'active').length
  }
  return count
}

function activeSamplerCount(): number {
  let count = 0
  for (const handle of activeEvents.values()) {
    if (handle.kind === 'sampler') count += 1
  }
  return count
}

function clearPreviewId(id: number) {
  const idx = previewIds.indexOf(id)
  if (idx >= 0) previewIds.splice(idx, 1)
}

function pickVoiceToSteal(pool: VoiceSlot[]): VoiceSlot {
  return pool.reduce((oldest, slot) => {
    if (slot.busyUntil !== oldest.busyUntil) {
      return slot.busyUntil < oldest.busyUntil ? slot : oldest
    }
    return slot.lastStart < oldest.lastStart ? slot : oldest
  })
}

function acquireVoice(kind: SynthKind): VoiceSlot {
  const now = Tone.now()
  const pool = getPool(kind)
  const idle = pool.find((slot) => slot.state === 'idle' || slot.busyUntil <= now)
  if (idle) {
    clearIdleTimer(idle)
    return idle
  }

  if (pool.length < maxVoicesBySynth[kind]) {
    const slot = createVoiceSlot(kind)
    pool.push(slot)
    return slot
  }

  const slot = pickVoiceToSteal(pool)
  clearIdleTimer(slot)
  return slot
}

function fadeOutVoice(synth: SynthVoice) {
  try {
    synth.volume.cancelScheduledValues(Tone.now())
    synth.volume.setValueAtTime(synth.volume.value, Tone.now())
    synth.volume.linearRampTo(-60, FADEOUT_S)
  } catch { /* already disposed */ }
}

function scheduleVoiceIdle(id: number, slot: VoiceSlot, token: number, delaySeconds: number) {
  clearIdleTimer(slot)
  slot.busyUntil = Tone.now() + delaySeconds
  slot.idleTimer = setTimeout(() => {
    const handle = activeEvents.get(id)
    if (handle?.kind === 'synth' && handle.token === token) {
      activeEvents.delete(id)
    }
    if (slot.token !== token) return
    slot.state = 'idle'
    slot.busyUntil = 0
    slot.idleTimer = null
    clearPreviewId(id)
  }, delaySeconds * 1000)
}

function releaseActiveEvent(id: number, handle: ActiveSynthEventHandle | ActiveSamplerEventHandle) {
  activeEvents.delete(id)
  clearPreviewId(id)

  if (handle.kind === 'sampler') {
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer)
      handle.idleTimer = null
    }
    pianoSampler?.triggerRelease(handle.note, Tone.now())
    return
  }

  const { slot, token } = handle
  if (slot.token !== token) return

  clearIdleTimer(slot)
  fadeOutVoice(slot.synth)
  slot.busyUntil = Tone.now() + FADEOUT_S + 0.02
  slot.idleTimer = setTimeout(() => {
    if (slot.token !== token) return
    slot.state = 'idle'
    slot.busyUntil = 0
    slot.idleTimer = null
  }, (FADEOUT_S + 0.02) * 1000)
}

function prepareVoiceForNote(synth: SynthVoice, volume: number, time: number) {
  synth.volume.cancelScheduledValues(time)
  synth.volume.setValueAtTime(volume, time)
}

function decibelsToVelocity(volume: number): number {
  return Math.max(0, Math.min(1, 10 ** (volume / 20)))
}

function triggerPianoSamplerNote(config: ResolvedLineSoundConfig, triggerTime: number) {
  const sampler = getLoadedPianoSampler()
  if (!sampler) {
    void createPianoSampler()
    return false
  }

  sampler.triggerAttackRelease(config.note, config.duration, triggerTime, decibelsToVelocity(config.volume))
  return true
}

function scheduleSamplerEventIdle(id: number, note: string, delaySeconds: number) {
  const handle: ActiveSamplerEventHandle = {
    kind: 'sampler',
    note,
    idleTimer: null,
  }

  handle.idleTimer = setTimeout(() => {
    const active = activeEvents.get(id)
    if (active !== handle) return
    activeEvents.delete(id)
    handle.idleTimer = null
    clearPreviewId(id)
  }, delaySeconds * 1000)

  activeEvents.set(id, handle)
}

function scheduleEvent(event: EngineEvent, time: number, onTrigger: () => void, shouldTrigger: ShouldTrigger = () => true): number {
  const id = Tone.getTransport().schedule((triggerTime) => {
    pendingIds.delete(id)

    if (!shouldTrigger()) return

    if (event.kind !== 'note') return

    const { config } = event
    const engine = getEngineKind(config.synth)
    if (engine === 'PianoSampler') {
      if (!triggerPianoSamplerNote(config, triggerTime)) return
      const releaseDelay = Tone.Time(config.duration).toSeconds() + PIANO_RELEASE + 0.1
      scheduleSamplerEventIdle(id, config.note, releaseDelay)
      onTrigger()
      debugAudio('note', { note: config.note, synth: config.synth, mode: 'scheduled' })
      return
    }

    const kind = engine
    const slot = acquireVoice(kind)
    const token = slot.token + 1
    slot.token = token
    slot.state = 'active'
    slot.lastStart = Tone.now()

    prepareVoiceForNote(slot.synth, config.volume, triggerTime)
    slot.synth.triggerAttackRelease(config.note, config.duration, triggerTime)

    activeEvents.set(id, { kind: 'synth', slot, token })
    onTrigger()
    debugAudio('note', { note: config.note, synth: config.synth, mode: 'scheduled' })

    const releaseDelay = Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
    scheduleVoiceIdle(id, slot, token, releaseDelay)
  }, time)

  pendingIds.add(id)
  return id
}

function activePreviewCount(): number {
  return previewIds.filter((id) => pendingIds.has(id) || pendingPreviewTimeouts.has(id) || activeEvents.has(id)).length
}

function trimPreviewIds() {
  for (let i = previewIds.length - 1; i >= 0; i -= 1) {
    const id = previewIds[i]
    if (!pendingIds.has(id) && !pendingPreviewTimeouts.has(id) && !activeEvents.has(id)) {
      previewIds.splice(i, 1)
    }
  }
}

let _debugLastLog = 0

function debugAudio(label: string, extra?: Record<string, unknown>) {
  const now = Date.now()
  if (now - _debugLastLog < 500) return
  _debugLastLog = now
  const fields: Record<string, unknown> = {
    queue: activePreviewCount(),
    samplerVoices: activeSamplerCount(),
    synthVoices: activeVoiceCount(),
    droppedTotal: droppedPreviewCount,
    ...extra,
  }

  const message = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  console.debug(`[audio:${label}] ${message}`)
}

const FILTER_MIN_HZ = 400
const FILTER_MAX_HZ = 12000

export function setFilterFrequency(energy: number) {
  const f = getFilter()
  const freq = FILTER_MIN_HZ * Math.pow(FILTER_MAX_HZ / FILTER_MIN_HZ, Math.max(0, Math.min(1, energy)))
  f.frequency.rampTo(freq, 0.1)
}

export function getAudioDebugSnapshot() {
  return {
    queue: activePreviewCount(),
    samplerVoices: activeSamplerCount(),
    synthVoices: activeVoiceCount(),
    droppedTotal: droppedPreviewCount,
  }
}

export function scheduleArrival(
  config: ResolvedLineSoundConfig,
  arrivalTime: number,
  onTrigger: () => void,
  shouldTrigger?: ShouldTrigger,
): number {
  return scheduleEvent({ kind: 'note', config }, arrivalTime, onTrigger, shouldTrigger)
}

export function triggerNoteAtTime(config: ResolvedLineSoundConfig, triggerTime: number): boolean {
  const engine = getEngineKind(config.synth)

  if (engine === 'PianoSampler') {
    return triggerPianoSamplerNote(config, triggerTime)
  }

  const slot = acquireVoice(engine)
  const token = slot.token + 1
  slot.token = token
  slot.state = 'active'
  slot.lastStart = Tone.now()

  prepareVoiceForNote(slot.synth, config.volume, triggerTime)
  slot.synth.triggerAttackRelease(config.note, config.duration, triggerTime)

  const id = nextPreviewEventId()
  activeEvents.set(id, { kind: 'synth', slot, token })
  const releaseDelay = Math.max(0, triggerTime - Tone.now()) + Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
  scheduleVoiceIdle(id, slot, token, releaseDelay)
  return true
}

export function cancelScheduled(id: number) {
  if (pendingIds.has(id)) {
    Tone.getTransport().clear(id)
    pendingIds.delete(id)
  }
  const pendingPreviewTimeout = pendingPreviewTimeouts.get(id)
  if (pendingPreviewTimeout) {
    clearTimeout(pendingPreviewTimeout)
    pendingPreviewTimeouts.delete(id)
  }
  clearPreviewId(id)
  const handle = activeEvents.get(id)
  if (handle) {
    releaseActiveEvent(id, handle)
  }
}

export function cancelAll() {
  for (const id of pendingIds) {
    Tone.getTransport().clear(id)
  }
  pendingIds.clear()
  for (const timeout of pendingPreviewTimeouts.values()) {
    clearTimeout(timeout)
  }
  pendingPreviewTimeouts.clear()
  for (const [id, handle] of activeEvents) {
    Tone.getTransport().clear(id)
    releaseActiveEvent(id, handle)
  }
  activeEvents.clear()
  pianoSampler?.releaseAll(Tone.now())
  previewIds.length = 0
}

export function disposeEffects() {
  cancelAll()
  for (const pool of voicePools.values()) {
    for (const slot of pool) {
      clearIdleTimer(slot)
      try { slot.synth.dispose() } catch { /* already disposed */ }
    }
  }
  voicePools.clear()
  if (pianoSampler) {
    pianoSampler.dispose()
    pianoSampler = null
  }
  pianoSamplerLoadVersion += 1
  pianoSamplerLoadPromise = null
  if (filter) {
    filter.dispose()
    filter = null
  }
  if (reverb) {
    reverb.dispose()
    reverb = null
  }
  if (limiter) {
    limiter.dispose()
    limiter = null
  }
  droppedPreviewCount = 0
}

const MAX_PREVIEWS = 10

function nextPreviewEventId(): number {
  const id = nextImmediateEventId
  nextImmediateEventId -= 1
  return id
}

function triggerPreviewNow(id: number, config: ResolvedLineSoundConfig, triggerTime: number): number | null {
  const engine = getEngineKind(config.synth)

  if (engine === 'PianoSampler') {
    if (!triggerPianoSamplerNote(config, triggerTime)) return null
    const releaseDelay = Math.max(0, triggerTime - Tone.now()) + Tone.Time(config.duration).toSeconds() + PIANO_RELEASE + 0.1
    scheduleSamplerEventIdle(id, config.note, releaseDelay)
    debugAudio('note', { note: config.note, synth: config.synth, mode: 'preview' })
    return id
  }

  const slot = acquireVoice(engine)
  const token = slot.token + 1
  slot.token = token
  slot.state = 'active'
  slot.lastStart = Tone.now()

  prepareVoiceForNote(slot.synth, config.volume, triggerTime)
  slot.synth.triggerAttackRelease(config.note, config.duration, triggerTime)

  activeEvents.set(id, { kind: 'synth', slot, token })
  debugAudio('note', { note: config.note, synth: config.synth, mode: 'preview' })

  const releaseDelay = Math.max(0, triggerTime - Tone.now()) + Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
  scheduleVoiceIdle(id, slot, token, releaseDelay)
  return id
}

export function playNow(config: ResolvedLineSoundConfig): void {
  trimPreviewIds()
  let dropped = 0
  while (activePreviewCount() >= MAX_PREVIEWS && previewIds.length > 0) {
    cancelScheduled(previewIds.shift()!)
    dropped += 1
  }
  if (dropped > 0) {
    droppedPreviewCount += dropped
    debugAudio('preview-drop', { dropped, maxQueue: MAX_PREVIEWS })
  }

  const id = nextPreviewEventId()
  const timeout = setTimeout(() => {
    pendingPreviewTimeouts.delete(id)
    const playedId = triggerPreviewNow(id, config, Tone.now() + 0.01)
    if (playedId === null) {
      clearPreviewId(id)
    }
  }, 50)

  pendingPreviewTimeouts.set(id, timeout)
  previewIds.push(id)
}
