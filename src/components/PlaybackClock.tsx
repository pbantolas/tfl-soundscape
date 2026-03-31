type PlaybackClockProps = {
  scrubMs: number
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  const s = d.getSeconds()
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function PlaybackClock({ scrubMs }: PlaybackClockProps) {
  const time = formatTime(scrubMs)

  return (
    <div className="flex font-pixel text-5xl sm:text-7xl select-none text-tfl-amber antialiased">
      {time.split('').map((char, index) => (
        <span key={index} className={char === ':' ? 'w-[0.5em] text-center' : 'w-[1ch] text-center'}>
          {char}
        </span>
      ))}
    </div>
  )
}
