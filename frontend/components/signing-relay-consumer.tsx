"use client";

/**
 * frontend/components/signing-relay-consumer.tsx
 *
 * Polls /api/signing-relay for pending signing requests from bots and
 * attempts to satisfy them using the connected Solana wallet. Currently
 * supports basic SOL transfers (heuristic match on function/module names).
 */

import { useCallback, useEffect, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, TransactionInstruction } from "@solana/web3.js";
import type { SigningRequest } from "@/lib/signing-relay-store";

const POLL_INTERVAL_MS = 1_500;

interface SigningRelayConsumerProps {
  onLog?: (line: string) => void;
  botRunning?: boolean;
}

export function SigningRelayConsumer({ onLog, botRunning = true }: SigningRelayConsumerProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const processingRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = useCallback(
    (msg: string) => {
      const line = `[SignRelay] ${msg}`;
      console.log(line);
      onLog?.(line);
    },
    [onLog]
  );

  const signRequest = useCallback(
    async (request: SigningRequest) => {
      if (processingRef.current.has(request.id)) return;
      processingRef.current.add(request.id);

      log(`Processing request ${request.id} network=${request.network} module=${request.moduleName} fn=${request.functionName}`);

      try {
        if (!publicKey) throw new Error("Wallet not connected.");
        // If the request includes a raw serialized Solana transaction, prefer
        // to deserialize, sign with the connected wallet and submit it.
        if (request.rawTx) {
          const raw = String(request.rawTx || "");
          if (!raw) throw new Error("Empty rawTx payload");
          const tx = Transaction.from(Buffer.from(raw, 'base64'));
          tx.feePayer = publicKey;
          try {
            const latest = await connection.getLatestBlockhash();
            tx.recentBlockhash = latest.blockhash;
          } catch {}

          let sig: string | undefined;
          if (typeof signTransaction === "function") {
            const signed = await signTransaction(tx);
            sig = await connection.sendRawTransaction(signed.serialize());
          } else if (typeof sendTransaction === "function") {
            sig = await sendTransaction(tx, connection);
          } else {
            throw new Error("Wallet not available to sign raw transaction.");
          }

          await connection.confirmTransaction(sig, "confirmed");
          log(`✓ Signed & broadcast (rawTx): ${sig}`);
          await fetch(`/api/signing-relay/${request.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash: sig }),
          });
          return;
        }

        // If the request includes a Solana-style instruction (programId + instructionData),
        // construct and sign the TransactionInstruction.
        if (request.programId && request.instructionData) {
          const programIdStr = String(request.programId || "").trim();
          const dataStr = String(request.instructionData || "").trim();
          const decodeAsHex = /^0x[0-9a-fA-F]+$/.test(dataStr) || (/^[0-9a-fA-F]+$/.test(dataStr) && dataStr.length % 2 === 0);
          const dataBuf = decodeAsHex ? Buffer.from(dataStr.replace(/^0x/, ""), "hex") : Buffer.from(dataStr, "base64");

          const accountsRaw = Array.isArray(request.accounts) ? request.accounts : [];
          const keys = accountsRaw.map((a: any) => {
            const pub = String(a?.pubkey ?? a?.pubKey ?? a?.address ?? "").trim();
            return { pubkey: new PublicKey(pub), isSigner: Boolean(a?.isSigner), isWritable: Boolean(a?.isWritable) };
          });

          const ix = new TransactionInstruction({ keys, programId: new PublicKey(programIdStr), data: dataBuf });
          const tx = new Transaction().add(ix);
          tx.feePayer = publicKey;
          try {
            const latest = await connection.getLatestBlockhash();
            tx.recentBlockhash = latest.blockhash;
          } catch {}

          let sig: string | undefined;
          if (typeof signTransaction === "function") {
            const signed = await signTransaction(tx);
            sig = await connection.sendRawTransaction(signed.serialize());
          } else if (typeof sendTransaction === "function") {
            sig = await sendTransaction(tx, connection);
          } else {
            throw new Error("Wallet not available to sign instruction.");
          }

          await connection.confirmTransaction(sig, "confirmed");
          log(`✓ Signed & broadcast (instruction): ${sig}`);
          await fetch(`/api/signing-relay/${request.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash: sig }),
          });
          return;
        }

        // Basic mapping: treat legacy requests that look like 'transfer' or 'send'
        // as SOL transfers. Bots/generators should be updated to emit explicit
        // Solana instructions or rawTx for more complex flows.
        if (/transfer|send/i.test(request.functionName || "") || /bank|token/i.test(request.moduleName || "")) {
          const to = String(request.args?.[0] ?? "").trim();
          const amountStr = String(request.args?.[1] ?? "0").trim();
          if (!to) throw new Error("Missing recipient address.");
          const amount = parseFloat(amountStr);
          if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount.");

          const toPubkey = new PublicKey(to);
          const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

          const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: publicKey, toPubkey, lamports })
          );

          tx.feePayer = publicKey;
          try {
            const latest = await connection.getLatestBlockhash();
            tx.recentBlockhash = latest.blockhash;
          } catch {
            // ignore — wallet adapter may set a blockhash when sending
          }

          let sig: string | undefined;
          if (typeof sendTransaction === "function") {
            sig = await sendTransaction(tx, connection);
          } else if (typeof signTransaction === "function") {
            const signed = await signTransaction(tx);
            sig = await connection.sendRawTransaction(signed.serialize());
          } else {
            throw new Error("Wallet does not support sending transactions.");
          }

          await connection.confirmTransaction(sig, "confirmed");
          log(`✓ Signed & broadcast (Solana): ${sig}`);
          await fetch(`/api/signing-relay/${request.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash: sig }),
          });
          return;
        }

        // Unsupported request types — return a helpful error so the
        // backend or generator author can migrate to Solana instructions.
        const message = `Unsupported signing request (module=${request.moduleName}, fn=${request.functionName}). Migrate generator to emit Solana instructions.`;
        log(`✗ Unsupported request: ${message}`);
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: message }),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`✗ Signing failed: ${errorMsg}`);
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: errorMsg }),
        }).catch(() => {});
      } finally {
        processingRef.current.delete(request.id);
      }
    },
    [connection, log, publicKey, sendTransaction, signTransaction]
  );

  useEffect(() => {
    if (!botRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/signing-relay", { headers: { "Cache-Control": "no-store" } });
        if (!res.ok) return;
        const data = (await res.json()) as { requests: SigningRequest[] };
        for (const request of data.requests ?? []) {
          void signRequest(request);
        }
      } catch {
        // ignore transient errors
      }
    };

    void poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [botRunning, signRequest]);

  return null;
}
