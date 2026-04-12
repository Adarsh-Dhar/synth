import { RefObject, useRef, useEffect } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function useTerminal(): {
  terminalRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
} {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current || termRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      theme: {
        background: "#020617",
        foreground: "#22d3ee",
        green:      "#4ade80",
        yellow:     "#facc15",
        red:        "#f87171",
        cyan:       "#22d3ee",
        magenta:    "#c084fc",
        blue:       "#60a5fa",
      },
      fontSize: 12,
      fontFamily: "Menlo, 'Courier New', monospace",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current  = fit;
    term.writeln("\x1b[36m[System]\x1b[0m Terminal ready. Auto-starting bot…");
    const obs = new ResizeObserver(() => fit.fit());
    obs.observe(terminalRef.current);
    return () => { obs.disconnect(); term.dispose(); termRef.current = null; };
  }, []);

  return { terminalRef, termRef };
}
