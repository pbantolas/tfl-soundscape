import { useTflEngine } from './hooks/useTflEngine'
import { Scrubber } from './components/Scrubber'

function App() {
  const {
    running,
    displayItems,
    start,
    stop,
    playbackMode,
    autoRate,
    isLive,
    scrubMs,
    timelineStartMs,
    timelineEndMs,
    loopEndMs,
    allEvents,
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  } = useTflEngine()

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
          <div
            key={item.id}
            className="px-6 py-3 bg-neutral-900 rounded transition-opacity duration-700"
            style={{ opacity: item.visible ? 1 : 0 }}
          >
            <p className="text-2xl font-bold text-white/80 tracking-widest uppercase font-pixel">
              {item.stationName} — {item.lineName}
            </p>
          </div>
        ))}
      </div>

      {running && timelineEndMs > 0 && (
        <Scrubber
          scrubMs={scrubMs}
          timelineStartMs={timelineStartMs}
          timelineEndMs={timelineEndMs}
          loopEndMs={loopEndMs}
          allEvents={allEvents}
          isLive={isLive}
          isAutoPingPong={playbackMode === 'autoPingPong'}
          autoRate={autoRate}
          onSeekStart={seekStart}
          onSeek={seekAndPlay}
          onSeekEnd={seekAndPlay}
          onGoLive={goLive}
          onStartAutoPingPong={startAutoPingPong}
        />
      )}
    </div>
  )
}

export default App
