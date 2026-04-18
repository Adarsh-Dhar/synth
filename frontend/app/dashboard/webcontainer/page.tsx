"use client";

/**
 * frontend/app/dashboard/webcontainer/page.tsx
 *
 * Backend runtime launcher page.
 *
 * Legacy browser sandbox execution was removed during the Enterprise
 * DeFAI migration in favor of backend-managed workers.
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
        <h1 className="text-xl font-bold text-slate-100">Runtime Launcher</h1>
        <p className="text-sm text-slate-500 mt-1">
          Start an existing agent on the backend worker and monitor it from the agent details page.
        </p>
      </div>
      <WebContainerRunner />
    </div>
  );
}