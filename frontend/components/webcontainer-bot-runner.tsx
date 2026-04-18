"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function WebContainerBotRunner() {
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState<string>("");

  const startAgent = async () => {
    const trimmed = agentId.trim();
    if (!trimmed) {
      setError("Agent id is required.");
      return;
    }

    setError("");
    setStatus("starting");
    const res = await fetch(`/api/agents/${encodeURIComponent(trimmed)}/start`, {
      method: "POST",
    });

    if (!res.ok) {
      const body = await res.text();
      setStatus("error");
      setError(body || `Failed to start agent (${res.status}).`);
      return;
    }

    setStatus("running");
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950 p-5 text-slate-100">
      <h2 className="text-lg font-semibold">Backend Runtime Launcher</h2>
      <p className="mt-1 text-sm text-slate-400">
        WebContainer execution has been removed. Agents now run in backend-managed workers.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block text-sm text-slate-300" htmlFor="agentId">
          Agent ID
        </label>
        <input
          id="agentId"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
          placeholder="Enter an existing agent id"
        />

        <div className="flex gap-2">
          <Button onClick={startAgent}>Start on Worker</Button>
          <Link href={agentId.trim() ? `/dashboard/agents/${encodeURIComponent(agentId.trim())}` : "/dashboard"}>
            <Button variant="outline">Open Agent Details</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-slate-800 bg-slate-900/60 p-3 text-sm">
        <div className="text-slate-400">Runtime status: <span className="text-slate-200">{status}</span></div>
        {error ? <div className="mt-2 text-red-400">{error}</div> : null}
      </div>
    </section>
  );
}
