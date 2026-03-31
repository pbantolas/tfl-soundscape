import { useTflEngine } from './hooks/useTflEngine'
import { Scrubber } from './components/Scrubber'

function App() {
  const {
    running,
    audioReady,
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
    lineColors,
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  } = useTflEngine()

  const visibleDisplayItems = displayItems.slice(-3)
  const showIdleMessage = visibleDisplayItems.length === 0 && !isLive

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 text-white">
      <div className="flex flex-col items-center justify-center gap-2">
        {showIdleMessage && (
          <div className="px-6 py-3 bg-neutral-900 rounded">
            <p className="text-5xl text-white/80 tracking-tight font-pixel antialiased">
              {hasBufferedEvents
                ? (audioReady ? 'Scrub, go live, or press play' : 'Tap anywhere on the timeline to unlock audio')
                : 'Loading arrivals...'}
            </p>
          </div>
        )}
        {visibleDisplayItems.map(item => (
          <div
            key={item.id}
            className="px-6 py-3 bg-neutral-900 rounded transition-opacity duration-700"
            style={{ opacity: item.visible ? 1 : 0 }}
          >
            <p className="text-5xl text-white/80 tracking-tight font-pixel antialiased">
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
          lineColors={lineColors}
          isLive={isLive}
          isAutoPingPong={playbackMode === 'autoPingPong'}
          autoRate={autoRate}
          audioReady={audioReady}
          hasTimeline={hasBufferedEvents}
          running={running || playbackMode === 'autoPingPong'}
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
