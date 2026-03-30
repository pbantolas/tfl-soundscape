import * as Tone from 'tone'
import type { LineSoundConfig } from '../config/types'

const synthFactories: Record<string, () => Tone.Synth<Tone.SynthOptions> | Tone.FMSynth | Tone.AMSynth | Tone.MonoSynth | Tone.MembraneSynth> = {
  Synth: () => new Tone.Synth(),
  FMSynth: () => new Tone.FMSynth(),
  AMSynth: () => new Tone.AMSynth(),
  MonoSynth: () => new Tone.MonoSynth(),
  MembraneSynth: () => new Tone.MembraneSynth(),
}

export function scheduleArrival(
  config: LineSoundConfig,
  arrivalTime: number,
  onTrigger: () => void
): number {
  const factory = synthFactories[config.synth] ?? synthFactories.Synth
  const synth = factory().toDestination()
  synth.volume.value = config.volume

  const id = Tone.getTransport().schedule((time) => {
    synth.triggerAttackRelease(config.note, config.duration, time)
    onTrigger()

    const disposeDelay = Tone.Time(config.duration).toSeconds() + 0.1
    setTimeout(() => synth.dispose(), disposeDelay * 1000)
  }, arrivalTime)

  return id
}

export function cancelScheduled(id: number) {
  Tone.getTransport().clear(id)
}
