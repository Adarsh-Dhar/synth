import { GeneratedFile } from "@/lib/types";

interface FileExplorerProps {
  files: GeneratedFile[];
  selectedFile: string | null;
  onSelect: (filepath: string) => void;
}

export function FileExplorer({ files, selectedFile, onSelect }: FileExplorerProps) {
  // Filter out files with missing or invalid filepath
  const validFiles = files.filter(f => typeof f.filepath === 'string' && f.filepath.length > 0);
  return (
    <div className="w-52 border-r border-slate-800 bg-slate-900/30 p-2 overflow-y-auto">
      <div className="text-[10px] uppercase text-slate-600 font-black mb-2 px-2 tracking-widest">Explorer</div>
      {[...new Map(validFiles.map(f => [f.filepath, f])).values()].map(file => (
        <button
          key={file.filepath}
          onClick={() => onSelect(file.filepath)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs mb-0.5 transition-colors text-left ${
            selectedFile === file.filepath
              ? "bg-cyan-600/10 text-cyan-400 border border-cyan-500/20"
              : "text-slate-500 hover:bg-slate-800/50 hover:text-slate-300"
          }`}
        >
          {file.filepath.endsWith('.sol') ? (
            <div className="w-3 h-3 rounded-full bg-indigo-500 mr-1" />
          ) : (
            <span className={selectedFile === file.filepath ? "text-cyan-400" : "text-slate-600"}>📄</span>
          )}
          <span className="truncate">{file.filepath}</span>
        </button>
      ))}
    </div>
  );
}
