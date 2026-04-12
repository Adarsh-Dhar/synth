"use client"

import React, { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface LoginModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LoginModal({ open, onOpenChange }: LoginModalProps) {
  const [isLoading, setIsLoading] = useState(false)

  const handleConnect = () => {
    setIsLoading(true)
    // Simulate InterwovenKit login process
    setTimeout(() => {
      window.location.href = '/dashboard'
    }, 1500)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Wallet</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-6">
          <p className="text-sm text-foreground/70">
            Connect your wallet to access Synth and start deploying autonomous AI trading agents.
          </p>

          <div className="space-y-3">
            <Button
              onClick={handleConnect}
              disabled={isLoading}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isLoading ? 'Connecting...' : 'Connect Wallet'}
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-card text-foreground/60">Or continue with</span>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full border-border hover:border-primary/50 hover:bg-primary/5"
            >
              Interwoven Wallet
            </Button>

            <Button
              variant="outline"
              className="w-full border-border hover:border-primary/50 hover:bg-primary/5"
            >
              Solana Extension
            </Button>
          </div>

          <p className="text-xs text-foreground/50 text-center">
            By connecting, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
