"use client";

/**
 * frontend/components/auth-button.tsx
 *
 * Drop-in replacement for WalletMultiButton.
 * Shows:
 *   - "Sign In" → opens Privy modal (wallet + GitHub + Google options)
 *   - When connected → avatar/name + "Sign Out" dropdown
 *
 * Usage:
 *   import { AuthButton } from "@/components/auth-button";
 *   <AuthButton />
 */

import React, { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCurrentIdentity } from "@/lib/auth/privy-client";
import { LogOut, Github, Globe, Wallet, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Auth-method icon ──────────────────────────────────────────────────────────

function AuthIcon({ method }: { method: "wallet" | "github" | "google" | null }) {
  if (method === "github") return <Github size={14} className="shrink-0" />;
  if (method === "google") return <Globe size={14} className="shrink-0" />;
  return <Wallet size={14} className="shrink-0" />;
}

// ── Main component ────────────────────────────────────────────────────────────

interface AuthButtonProps {
  className?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default" | "lg";
}

export function AuthButton({
  className = "",
  variant = "default",
  size = "default",
}: AuthButtonProps) {
  const { login, logout, authenticated, ready } = usePrivy();
  const { displayName, authMethod, address } = useCurrentIdentity();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  if (!ready) {
    return (
      <Button
        variant={variant}
        size={size}
        disabled
        className={`bg-primary/50 text-primary-foreground ${className}`}
      >
        <span className="w-3 h-3 rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground animate-spin mr-2" />
        Loading…
      </Button>
    );
  }

  // ── Not logged in ─────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <Button
        variant={variant}
        size={size}
        onClick={login}
        className={`bg-primary hover:bg-primary/90 text-primary-foreground ${className}`}
      >
        Connect / Sign In
      </Button>
    );
  }

  // ── Logged in ─────────────────────────────────────────────────────────────
  return (
    <div className="relative">
      <button
        onClick={() => setDropdownOpen((o) => !o)}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border
          bg-card/80 hover:bg-card text-sm text-foreground transition-colors
          ${className}
        `}
      >
        {/* Auth method icon */}
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/15 border border-primary/30 text-primary">
          <AuthIcon method={authMethod} />
        </span>

        {/* Display name */}
        <span className="font-mono text-xs max-w-[120px] truncate">
          {displayName ?? "Connected"}
        </span>

        <ChevronDown
          size={12}
          className={`text-muted-foreground transition-transform ${
            dropdownOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Dropdown */}
      {dropdownOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setDropdownOpen(false)}
          />

          <div className="absolute right-0 top-full mt-2 z-50 min-w-[200px] bg-card border border-border rounded-xl shadow-xl overflow-hidden">
            {/* Identity info */}
            <div className="px-4 py-3 border-b border-border/60">
              <div className="flex items-center gap-2 mb-1">
                <AuthIcon method={authMethod} />
                <span className="text-xs font-semibold text-muted-foreground capitalize">
                  {authMethod ?? "Connected"}
                </span>
              </div>
              <p className="text-xs font-mono text-foreground/80 truncate">
                {displayName}
              </p>
              {address && (
                <p className="text-[10px] font-mono text-muted-foreground/60 truncate mt-0.5">
                  {address.slice(0, 10)}…{address.slice(-6)}
                </p>
              )}
            </div>

            {/* Sign out */}
            <button
              onClick={async () => {
                setDropdownOpen(false);
                await logout();
              }}
              className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        </>
      )}
    </div>
  );
}