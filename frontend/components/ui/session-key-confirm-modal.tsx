"use client";
import { Check, Lock, AlertCircle } from "lucide-react";
import { Button } from "./button";

interface SessionKeyConfirmModalProps {
  isOpen: boolean;
  isEnabled: boolean;
  sessionAddress: string;
  userAddress: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDryRun?: boolean;
}

export function SessionKeyConfirmModal({
  isOpen,
  isEnabled,
  sessionAddress,
  userAddress,
  onConfirm,
  onCancel,
  isDryRun = false,
}: SessionKeyConfirmModalProps) {
  const canContinue = Boolean(userAddress && sessionAddress);

  if (!isOpen) return null;

  if (isEnabled) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-700 bg-slate-950 flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center">
              <Check size={20} className="text-green-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Session Key Active</h2>
              <p className="text-xs text-slate-400">AutoSign signing permissions enabled</p>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 bg-slate-950 rounded-lg border border-slate-800">
                <Lock size={16} className="text-cyan-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 text-xs text-slate-300">
                  <p className="font-medium mb-1">Your wallet is secured</p>
                  <p className="text-slate-400">
                    Only your browser holds the signing key. Your master wallet seed never touches this server.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-slate-950 rounded-lg border border-slate-800">
                <Check size={16} className="text-green-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 text-xs text-slate-300">
                  <p className="font-medium mb-1">AutoSign grant already active</p>
                  <p className="text-slate-400">
                    AutoSign setup already handled wallet derivation and on-chain grants for this session wallet.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-slate-950 rounded-lg border border-slate-800">
                <Lock size={16} className="text-cyan-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 text-xs text-slate-300 break-all">
                  <p className="font-medium mb-1">Session wallet grantee</p>
                  <p className="text-slate-400">{sessionAddress || "Unavailable"}</p>
                </div>
              </div>

              {!isDryRun && (
                <div className="flex items-start gap-3 p-3 bg-amber-500/10 rounded-lg border border-amber-500/30">
                  <AlertCircle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-xs text-amber-300">
                    <p className="font-medium mb-1">LIVE Mode</p>
                    <p className="text-amber-200">
                      Real transactions will be sent. Ensure your bot logic is correct before deploying.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="px-6 py-4 border-t border-slate-700 bg-slate-950 flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canContinue}
              onClick={onConfirm}
              className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white"
            >
              Continue & Launch
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show disabled state
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-700 bg-slate-950 flex items-center gap-3">
          <div className="flex-shrink-0 w-10 h-10 bg-red-500/20 rounded-full flex items-center justify-center">
            <AlertCircle size={20} className="text-red-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">AutoSign Not Enabled</h2>
            <p className="text-xs text-slate-400">Session key permissions required</p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-slate-300">
            Before launching your bot, you need to enable AutoSign signing permissions. This allows your bot to sign
            transactions securely without exposing your master wallet seed.
          </p>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-2">
            <p className="text-xs font-medium text-slate-200">To enable AutoSign:</p>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside">
              <li>Look for "AutoSign" in the sidebar or settings</li>
              <li>Click to enable and approve the signing scope</li>
              <li>Come back to launch your bot</li>
            </ol>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-700 bg-slate-950 flex gap-3">
          <Button
            size="sm"
            onClick={onCancel}
            className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600"
            variant="outline"
          >
            Got It
          </Button>
        </div>
      </div>
    </div>
  );
}
