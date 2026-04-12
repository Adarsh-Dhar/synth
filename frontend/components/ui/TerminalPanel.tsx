import { Terminal as TerminalIcon } from "lucide-react";
import { RefObject } from "react";

interface TerminalPanelProps {
  terminalRef: RefObject<HTMLDivElement | null>;
  onClear: () => void;
}

export function TerminalPanel({ terminalRef, onClear }: TerminalPanelProps) {
  return (
    <div className="h-64 border-t border-slate-800 bg-[#020617] flex flex-col">
      <div className="flex items-center justify-between px-4 py-1.5 bg-slate-900/40 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <TerminalIcon size={12} className="text-slate-500" />
          <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal</span>
        </div>
        <button
          onClick={onClear}
          className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 p-1 overflow-hidden" ref={terminalRef} />
    </div>
  );
}
