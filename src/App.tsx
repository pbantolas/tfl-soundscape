import { useTflEngine } from './hooks/useTflEngine'

function App() {
  const { running, display, start, stop } = useTflEngine()

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

      <div
        className="h-16 flex items-center justify-center transition-opacity duration-700"
        style={{ opacity: display ? 1 : 0 }}
      >
        {display && (
          <p className="text-lg text-white/60 tracking-widest uppercase">
            {display.stationName} — {display.lineName}
          </p>
        )}
      </div>
    </div>
  )
}

export default App
