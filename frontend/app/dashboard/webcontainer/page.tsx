"use client";

/**
 * frontend/app/dashboard/webcontainer/page.tsx
 *
 * Bot IDE — loads the most recently generated bot from the DB
 * (or a specific agentId passed as ?agentId=xxx query param).
 * Works with both the old hardcoded bot and new custom bots.
 */

import dynamic from "next/dynamic";

const WebContainerRunner = dynamic(
  () => import("@/components/webcontainer-bot-runner").then(m => m.WebContainerBotRunner),
  { ssr: false }
);

export default function WebContainerPage() {
  return (
    <div className="p-6 max-w-full min-h-screen bg-slate-950">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-100">Bot IDE</h1>
        <p className="text-sm text-slate-500 mt-1">
          Review, edit, and run your generated arbitrage bot in a sandboxed WebContainer environment.
        </p>
      </div>
      <WebContainerRunner />
    </div>
  );
}