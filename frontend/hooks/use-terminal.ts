import { RefObject, useMemo, useRef, useState } from "react";

type BasicTerminal = {
  clear: () => void;
  writeln: (line: string) => void;
};

export function useTerminal(): {
  terminalRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<BasicTerminal | null>;
  lines: string[];
  clear: () => void;
} {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  const termRef = useRef<BasicTerminal | null>(null);
  if (!termRef.current) {
    termRef.current = {
      clear: () => {
        setLines([]);
      },
      writeln: (line: string) => {
        setLines((prev) => [...prev.slice(-499), line]);
      },
    };
  }

  const clear = useMemo(() => {
    return () => setLines([]);
  }, []);

  return { terminalRef, termRef, lines, clear };
}
