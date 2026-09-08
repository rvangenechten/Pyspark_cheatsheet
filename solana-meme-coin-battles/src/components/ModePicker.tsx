import { MODES, type ModeId } from '../lib/coins'

export function ModePicker({
  value,
  onChange,
}: {
  value: ModeId
  onChange: (m: ModeId) => void
}) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-line w-fit">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            value === m.id ? 'bg-brand text-white' : 'text-mist hover:text-white'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
