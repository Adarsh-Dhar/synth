/**
 * frontend/app/dashboard/webcontainer/page.tsx
 *
 * Loads the WebContainerBotRunner dynamically (no SSR) so it only
 * runs in the browser — required because WebContainer uses browser APIs.
 */

import WebcontainerBotRunnerClient from "./WebcontainerBotRunnerClient";

export default function WebcontainerPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold">Arbitrage Bot IDE</h1>
          <p className="text-muted-foreground mt-1">
            Base Sepolia MCP flash-loan bot · USDC → WETH → USDC via 1inch + Aave
          </p>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        {/* COEP/COOP headers are set in next.config.mjs — required for SharedArrayBuffer */}
        <WebcontainerBotRunnerClient />

        {/* Quick reference */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              title: "1. Load Bot Files",
              body:  "Click \"Load Bot Files\" to fetch the complete TypeScript bot — config, MCP client, arbitrage logic, and entry point.",
            },
            {
              title: "2. Configure Credentials",
              body:  "Enable AutoSign first, then configure non-key environment values. Session key mode injects SOLANA_KEY at launch, so no master key paste is needed.",
            },
            {
              title: "3. Launch & Monitor",
              body:  "The bot polls every 5 seconds. Profitable cycles log the net USDC gain. Webacy checks both tokens before every execution.",
            },
          ].map((card) => (
            <div
              key={card.title}
              className="bg-card border border-border rounded-lg p-5"
            >
              <h3 className="font-semibold text-foreground mb-2">{card.title}</h3>
              <p className="text-sm text-muted-foreground">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}