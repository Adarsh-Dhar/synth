interface Props {
  options:  string[]
  onSelect: (value: string) => void
  disabled: boolean
}

export function Chips({ options, onSelect, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3">
      {options.map(o => (
        <button
          key={o}
          disabled={disabled}
          onClick={() => onSelect(o)}
          className="text-xs bg-card border border-border hover:border-primary/50 hover:bg-primary/5 text-foreground px-3 py-1.5 rounded-full transition-all disabled:opacity-40"
        >
          {o}
        </button>
      ))}
    </div>
  )
}