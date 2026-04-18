import { useState } from "react";

export function useSandbox() {
  const [phase, setPhase] = useState<"idle" | "env-setup" | "running">("idle");
  const [status, setStatus] = useState("Legacy browser sandbox removed");

  const bootAndRun = async () => {
    setPhase("running");
    setStatus("Execution now runs in backend workers");
  };

  const stopProcess = () => {
    setPhase("idle");
    setStatus("Stopped");
  };

  const updateFileInSandbox = async () => {
    return;
  };

  return {
    bootAndRun,
    phase,
    status,
    setPhase,
    setStatus,
    updateFileInSandbox,
    stopProcess,
  };
}
