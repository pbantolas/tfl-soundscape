import * as Tone from 'tone'
import type { ResolvedLineSoundConfig } from '../config/types'

const RELEASE = 2.5
const FADEOUT_S = 0.05

const envelope = { attack: 0.02, decay: 0.3, sustain: 0.5, release: RELEASE }

const synthFactories: Record<string, () => Tone.Synth<Tone.SynthOptions> | Tone.FMSynth | Tone.AMSynth> = {
  Synth:    () => new Tone.Synth({ envelope }),
  FMSynth:  () => new Tone.FMSynth({ envelope }),
  AMSynth:  () => new Tone.AMSynth({ envelope }),
}

const maxVoicesBySynth = {
  Synth: 12,
  FMSynth: 8,
  AMSynth: 8,
} as const

type SynthKind = keyof typeof maxVoicesBySynth
type SynthVoice = Tone.Synth<Tone.SynthOptions> | Tone.FMSynth | Tone.AMSynth

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
  slot: VoiceSlot
  token: number
}

type EngineEvent = {
  kind: 'note'
  config: ResolvedLineSoundConfig
}

let reverb: Tone.Reverb | null = null
let limiter: Tone.Limiter | null = null
const voicePools = new Map<SynthKind, VoiceSlot[]>()
const activeEvents = new Map<number, ActiveEventHandle>()

let _lastCtxState = ''

function checkCtxState() {
  const state = Tone.getContext().rawContext?.state ?? 'unknown'
  if (state !== _lastCtxState) {
    console.warn(`[audio:context] state changed: ${_lastCtxState || '(init)'} → ${state}`)
    _lastCtxState = state
  }
}

function getReverb(): Tone.Reverb {
  checkCtxState()
  if (!limiter) {
    limiter = new Tone.Limiter(-4).toDestination()
  }
  if (!reverb) {
    reverb = new Tone.Reverb({ decay: 4, preDelay: 0.02, wet: 0.45 }).connect(limiter)
    reverb.generate()
  }
  return reverb
}

// Transport event IDs that haven't fired yet (no voice lease exists)
const pendingIds = new Set<number>()
const previewIds: number[] = []

function normalizeSynthKind(synth: string): SynthKind {
  return synth in synthFactories ? synth as SynthKind : 'Synth'
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
  const synth = synthFactories[kind]().connect(getReverb())
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
    if (handle?.token === token) {
      activeEvents.delete(id)
    }
    if (slot.token !== token) return
    slot.state = 'idle'
    slot.busyUntil = 0
    slot.idleTimer = null
    clearPreviewId(id)
  }, delaySeconds * 1000)
}

function releaseActiveEvent(id: number, handle: ActiveEventHandle) {
  activeEvents.delete(id)
  clearPreviewId(id)

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

function scheduleEvent(event: EngineEvent, time: number, onTrigger: () => void): number {
  const id = Tone.getTransport().schedule((triggerTime) => {
    pendingIds.delete(id)

    if (event.kind !== 'note') return

    const { config } = event
    const kind = normalizeSynthKind(config.synth)
    const slot = acquireVoice(kind)
    const token = slot.token + 1
    slot.token = token
    slot.state = 'active'
    slot.lastStart = Tone.now()

    prepareVoiceForNote(slot.synth, config.volume, triggerTime)
    slot.synth.triggerAttackRelease(config.note, config.duration, triggerTime)

    activeEvents.set(id, { slot, token })
    onTrigger()

    const releaseDelay = Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
    scheduleVoiceIdle(id, slot, token, releaseDelay)
  }, time)

  pendingIds.add(id)
  return id
}

function activePreviewCount(): number {
  return previewIds.filter((id) => pendingIds.has(id) || activeEvents.has(id)).length
}

function trimPreviewIds() {
  for (let i = previewIds.length - 1; i >= 0; i -= 1) {
    const id = previewIds[i]
    if (!pendingIds.has(id) && !activeEvents.has(id)) {
      previewIds.splice(i, 1)
    }
  }
}

let _debugLastLog = 0
function debugAudio(label: string, extra?: Record<string, unknown>) {
  const now = Date.now()
  if (now - _debugLastLog < 500) return
  _debugLastLog = now
  const ctx = Tone.getContext().rawContext
  console.log(`[audio:${label}]`, {
    ctxState: ctx?.state,
    currentTime: ctx?.currentTime?.toFixed(2),
    activeVoices: activeVoiceCount(),
    pending: pendingIds.size,
    previews: activePreviewCount(),
    transportState: Tone.getTransport().state,
    ...extra,
  })
}

export function scheduleArrival(
  config: ResolvedLineSoundConfig,
  arrivalTime: number,
  onTrigger: () => void
): number {
  return scheduleEvent({ kind: 'note', config }, arrivalTime, onTrigger)
}

export function cancelScheduled(id: number) {
  Tone.getTransport().clear(id)
  pendingIds.delete(id)
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
  for (const [id, handle] of activeEvents) {
    Tone.getTransport().clear(id)
    releaseActiveEvent(id, handle)
  }
  activeEvents.clear()
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
  if (reverb) {
    reverb.dispose()
    reverb = null
  }
  if (limiter) {
    limiter.dispose()
    limiter = null
  }
}

const MAX_PREVIEWS = 10

export function playNow(config: ResolvedLineSoundConfig): void {
  debugAudio('playNow', { note: config.note, synth: config.synth })
  trimPreviewIds()
  while (activePreviewCount() >= MAX_PREVIEWS && previewIds.length > 0) {
    cancelScheduled(previewIds.shift()!)
  }
  const id = scheduleEvent({ kind: 'note', config }, Tone.now() + 0.05, () => {})
  previewIds.push(id)
}
