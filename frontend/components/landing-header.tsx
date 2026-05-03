"use client";

/**
 * frontend/components/landing-header.tsx  (updated)
 *
 * Replaces the Solana WalletMultiButton with the unified AuthButton
 * that supports wallet + GitHub + Google sign-in via Privy.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { AuthButton } from "@/components/auth-button";
import { useCurrentIdentity } from "@/lib/auth/privy-client";
import { Bot } from "lucide-react";

export function LandingHeader() {
  const router = useRouter();
  const { authenticated, ready } = usePrivy();
  const { displayName } = useCurrentIdentity();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <header className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
            <Bot className="text-primary-foreground" size={20} />
          </div>
          <div>
            <h1 className="font-bold text-lg text-sidebar-foreground">Synth</h1>
          </div>
        </Link>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-8">
          <a
            href="#features"
            className="text-sm text-foreground/70 hover:text-foreground transition-colors"
          >
            Features
          </a>
          <a
            href="#security"
            className="text-sm text-foreground/70 hover:text-foreground transition-colors"
          >
            Security
          </a>
          <a
            href="#"
            className="text-sm text-foreground/70 hover:text-foreground transition-colors"
          >
            Docs
          </a>
          {authenticated && (
            <Link
              href="/dashboard"
              className="text-sm text-foreground/70 hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
          )}
        </div>

        {/* Auth area */}
        <div className="flex items-center gap-3">
          {/* Short identity badge when logged in */}
          {authenticated && displayName && (
            <span className="hidden sm:block text-xs font-mono text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full border border-border/50 max-w-[140px] truncate">
              {displayName}
            </span>
          )}

          {mounted ? (
            authenticated ? (
              <Button
                onClick={() => router.push("/dashboard")}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                Open App
              </Button>
            ) : (
              /* Unified auth button (wallet + GitHub + Google) */
              <AuthButton />
            )
          ) : (
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled
            >
              Connect / Sign In
            </Button>
          )}
        </div>
      </nav>
    </header>
  );
}