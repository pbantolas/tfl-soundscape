import { useTflEngine } from './hooks/useTflEngine'
import { Scrubber } from './components/Scrubber'

function App() {
  const {
    running,
    hasBufferedEvents,
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 text-white">
      <div className="flex flex-col items-center justify-center gap-2">
        {!running && displayItems.length === 0 && (
          <div className="px-6 py-3 bg-neutral-900 rounded">
            <p className="text-2xl font-bold text-white/80 tracking-widest uppercase font-pixel">
              {hasBufferedEvents ? 'Press play to start from beginning' : 'Loading arrivals...'}
            </p>
          </div>
        )}
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

        <Scrubber
        scrubMs={scrubMs}
        timelineStartMs={timelineStartMs}
        timelineEndMs={timelineEndMs}
        loopEndMs={loopEndMs}
        allEvents={allEvents}
        isLive={isLive}
        isAutoPingPong={playbackMode === 'autoPingPong'}
          autoRate={autoRate}
          canStart={hasBufferedEvents}
          running={running}
          onSeekStart={seekStart}
        onSeek={seekAndPlay}
        onSeekEnd={seekAndPlay}
        onGoLive={goLive}
        onStartAutoPingPong={startAutoPingPong}
        onStart={start}
        onStop={stop}
      />
    </div>
  )
}

export default App
