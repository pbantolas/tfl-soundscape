import { useTflEngine } from './hooks/useTflEngine'
import { DisplayMessage } from './components/DisplayMessage'
import { PlaybackClock } from './components/PlaybackClock'
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
    loopStartMs,
    loopEndMs,
    allEvents,
    lineColors,
    lineEnergies,
    seekStart,
    seekAndPlay,
    goLive,
    startAutoPingPong,
  } = useTflEngine()

  const showIdleMessage = displayItems.length === 0 && !isLive

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg text-fg">
      <div className="absolute top-8 inset-x-0 flex justify-center">
        <PlaybackClock scrubMs={scrubMs} />
      </div>
      <div className="flex flex-col items-start justify-center gap-2 max-w-2xl w-full pb-44 px-4 sm:px-0">
        {showIdleMessage && (
          <DisplayMessage>
            {hasBufferedEvents
              ? (audioReady ? 'Scrub, go live, or press play' : 'TFL Sounds')
              : 'Loading arrivals...'}
          </DisplayMessage>
        )}
        {displayItems.map(item => (
          <DisplayMessage key={item.id} opacity={item.visible ? 1 : 0} color={lineColors[item.lineId]} direction={item.direction}>
            {item.stationName}
          </DisplayMessage>
        ))}
      </div>

      {Object.keys(lineEnergies).length > 0 && (
        <div className="fixed top-4 right-4 flex flex-col gap-1 font-mono text-[10px] opacity-60">
          {Object.entries(lineEnergies).map(([lineId, energy]) => (
            <div key={lineId} className="flex items-center gap-1.5">
              <span className="w-16 text-right capitalize">{lineId}</span>
              <div className="w-20 h-1.5 bg-fg/10 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-100"
                  style={{ width: `${energy * 100}%`, backgroundColor: lineColors[lineId] }}
                />
              </div>
              <span className="w-6 text-left">{(energy * 100).toFixed(0)}</span>
            </div>
          ))}
        </div>
      )}

      <Scrubber
          scrubMs={scrubMs}
          timelineStartMs={timelineStartMs}
          timelineEndMs={timelineEndMs}
          loopStartMs={loopStartMs}
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
