import { useTflEngine } from './hooks/useTflEngine'
import { Scrubber } from './components/Scrubber'

function App() {
  const { running, displayItems, start, stop, isLive, scrubMs, timelineStartMs, timelineEndMs, allEvents, seek, seekAndPlay, goLive } = useTflEngine()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-12 bg-neutral-950 text-white">
      <button
        onClick={running ? stop : start}
        className="w-20 h-20 rounded-full border-2 border-white/20 hover:border-white/50 transition-colors flex items-center justify-center"
      >
        {running ? (
          <div className="w-6 h-6 rounded-sm bg-white/80" />
        ) : (
          <div className="w-0 h-0 border-l-[14px] border-l-white/80 border-y-[10px] border-y-transparent ml-1" />
        )}
      </button>

      <div className="min-h-16 flex flex-col items-center justify-center gap-2">
        {displayItems.map(item => (
          <p
            key={item.id}
            className="text-3xl font-bold text-white/60 tracking-widest uppercase font-pixel transition-opacity duration-700"
            style={{ opacity: item.visible ? 1 : 0 }}
          >
            {item.stationName} — {item.lineName}
          </p>
        ))}
      </div>

      {running && timelineEndMs > 0 && (
        <Scrubber
          scrubMs={scrubMs}
          timelineStartMs={timelineStartMs}
          timelineEndMs={timelineEndMs}
          allEvents={allEvents}
          isLive={isLive}
          onSeek={seek}
          onSeekEnd={seekAndPlay}
          onGoLive={goLive}
        />
      )}
    </div>
  )
}

export default App
