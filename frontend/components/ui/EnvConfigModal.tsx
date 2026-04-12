import { EnvConfig } from "@/lib/types";
import { Settings, Zap } from "lucide-react";

interface EnvConfigModalProps {
  envConfig: EnvConfig;
  onChange: (key: keyof EnvConfig, value: string) => void;
  onLaunch: () => void;
  isDryRun: boolean;
}

export function EnvConfigModal({ envConfig, onChange, onLaunch, isDryRun }: EnvConfigModalProps) {
  return (
    <div className="absolute inset-0 z-20 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#0f172a] border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-900 flex items-center gap-2">
          <Settings size={15} className="text-cyan-400" />
          <div>
            <h3 className="text-sm font-bold text-slate-200">Flash Loan Configuration</h3>
            <p className="text-[10px] text-slate-400">
              Environment variables for the arbitrage bot ({isDryRun ? "SIM" : "LIVE"} mode)
            </p>
          </div>
        </div>
        <div className="p-5 space-y-3">
          {([
            { key: "SOLANA_RPC_URL", label: "Solana RPC URL",            type: "text",     placeholder: "https://api.devnet.solana.com" },
            { key: "SOLANA_KEY",     label: "Solana Private Key (optional)", type: "password", placeholder: "[base58 key array] (leave blank for DRY RUN)" },
            { key: "CONTRACT_ADDRESS", label: "Contract Address (Deployed)", type: "text", placeholder: "0xff75b696928640096181ba78e3b0e1188bf57393" },
            { key: "MAX_LOAN_USD",    label: "Max Flash Loan (USD)",     type: "number",   placeholder: "10000" },
            { key: "MIN_PROFIT_USD",  label: "Min Profit Target (USD)",  type: "number",   placeholder: "50" },
          ] as const).map(({ key, label, type, placeholder }) => (
            <div key={key}>
              <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">{label}</label>
              <input
                type={type}
                value={envConfig[key]}
                placeholder={placeholder}
                onChange={e => onChange(key, e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 focus:border-cyan-500/50 focus:outline-none transition-colors"
              />
            </div>
          ))}
          {envConfig.DRY_RUN === "false" && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
              ⚠️  LIVE mode — real transactions will be sent. Ensure your contract is deployed.
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-slate-800 bg-slate-900">
          <button
            onClick={onLaunch}
            className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:opacity-90 px-4 py-2.5 rounded-lg text-xs font-bold text-white transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
          >
            <Zap size={13} /> Launch Sandbox
          </button>
        </div>
      </div>
    </div>
  );
}
