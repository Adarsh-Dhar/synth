"use client";

import { MutableRefObject, useState } from "react";
import type { BotEnvConfig } from "@/lib/bot-constant";

export type BotPhase = "idle" | "env-setup" | "running" | "booting" | "installing";

interface BotFile {
  filepath: string;
  content: string;
}

interface UseBotSandboxOptions {
  generatedFiles: BotFile[];
  envConfig: BotEnvConfig;
  termRef: MutableRefObject<{ writeln: (line: string) => void } | null>;
}

export function useBotSandbox({ generatedFiles, envConfig, termRef }: UseBotSandboxOptions) {
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [status, setStatus] = useState("Idle");

  const stopProcess = async () => {
    setPhase("idle");
    setStatus("Stopped");
    termRef.current?.writeln("[system] execution is managed by the backend worker.");
  };

  const bootAndRun = async (launchEnvConfig?: BotEnvConfig): Promise<void> => {
    const effectiveEnv = launchEnvConfig ?? envConfig;
    const hasFiles = generatedFiles.length > 0;
    setPhase("running");
    setStatus("Delegated to worker");

    if (!hasFiles) {
      setPhase("idle");
      setStatus("No generated files found");
      termRef.current?.writeln("[error] no generated files available for backend execution.");
      return;
    }

    termRef.current?.writeln(
      `[system] browser sandbox disabled. launching via backend worker for network=${String(effectiveEnv.SOLANA_NETWORK || "devnet")}`,
    );
  };

  return {
    phase,
    setPhase,
    status,
    stopProcess,
    bootAndRun,
  };
}
