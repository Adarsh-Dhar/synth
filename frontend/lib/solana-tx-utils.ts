/**
 * Solana Transaction Utilities
 *
 * Shared helpers for on-chain transaction submission, confirmation, and verification
 * used across all MagicBlock tracks.
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";

/**
 * Submit and confirm a pre-signed transaction on Solana
 * Expects the transaction to be already signed by the client
 */
export async function submitAndConfirmTx(
  connection: Connection,
  rawTxBase64: string,
  maxRetries: number = 3
): Promise<string> {
  const txBytes = Buffer.from(rawTxBase64, "base64");
  const tx = Transaction.from(txBytes);

  let signature: string | null = null;
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  if (!signature) {
    throw new Error(
      `Failed to submit transaction after ${maxRetries} retries: ${lastError?.message ?? "Unknown error"}`
    );
  }

  try {
    await connection.confirmTransaction(signature, "confirmed");
  } catch (err) {
    throw new Error(
      `Transaction ${signature} did not confirm: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return signature;
}

/**
 * Get the owner and data of an on-chain account
 */
export async function getAccountInfo(
  connection: Connection,
  pubkey: PublicKey
): Promise<{
  owner: PublicKey;
  data: Buffer;
  lamports: number;
  executable: boolean;
} | null> {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) return null;

  return {
    owner: info.owner,
    data: info.data,
    lamports: info.lamports,
    executable: info.executable,
  };
}

/**
 * Verify that an account is owned by a specific program
 */
export async function verifyAccountOwner(
  connection: Connection,
  accountPubkey: PublicKey,
  expectedOwnerPubkey: PublicKey
): Promise<void> {
  const info = await getAccountInfo(connection, accountPubkey);
  if (!info) {
    throw new Error(`Account ${accountPubkey.toBase58()} not found on-chain`);
  }

  if (info.owner.toBase58() !== expectedOwnerPubkey.toBase58()) {
    throw new Error(
      `Account owner mismatch. Expected ${expectedOwnerPubkey.toBase58()}, got ${info.owner.toBase58()}`
    );
  }
}

/**
 * Get the current slot from a connection
 * Useful for health checks on TEE validators
 */
export async function getSlot(connection: Connection): Promise<number> {
  try {
    const slot = await connection.getSlot("confirmed");
    if (typeof slot !== "number" || slot <= 0) {
      throw new Error("Invalid slot returned from connection");
    }
    return slot;
  } catch (err) {
    throw new Error(
      `Failed to get current slot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Check if an RPC endpoint is responsive and returning valid data
 */
export async function verifyRpcHealth(endpoint: string): Promise<void> {
  try {
    const conn = new Connection(endpoint, { commitment: "confirmed" });
    const slot = await getSlot(conn);
    if (slot <= 0) {
      throw new Error("Received invalid slot number");
    }
  } catch (err) {
    throw new Error(
      `RPC health check failed for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Verify transaction was successfully executed on-chain
 */
export async function verifyTransactionStatus(
  connection: Connection,
  signature: string
): Promise<{
  confirmed: boolean;
  slot?: number;
  error?: string;
}> {
  const status = await connection.getSignatureStatus(signature, {
    searchTransactionHistory: true,
  });

  if (!status.value) {
    return { confirmed: false };
  }

  if (status.value.err) {
    return {
      confirmed: false,
      error: JSON.stringify(status.value.err),
    };
  }

  return {
    confirmed: true,
    slot: status.value.slot,
  };
}

/**
 * Derive a Program Derived Address (PDA) using seeds
 * Simple wrapper for PublicKey.findProgramAddressSync
 */
export function derivePDA(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}
