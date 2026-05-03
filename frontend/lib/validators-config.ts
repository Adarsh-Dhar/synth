/**
 * MagicBlock TEE Validator Configuration
 *
 * Centralized configuration for validator endpoints, public keys, and utilities
 * used across all three tracks: Private Brain, Shielded Execution, and A2A Payments.
 */

export const VALIDATOR_ENDPOINTS: Record<string, string> = {
  "mainnet-tee.magicblock.app": "https://mainnet-tee.magicblock.app",
  "devnet-tee.magicblock.app": "https://devnet-tee.magicblock.app",
  "as.magicblock.app": "https://as.magicblock.app",
  "eu.magicblock.app": "https://eu.magicblock.app",
  "us.magicblock.app": "https://us.magicblock.app",
  "devnet-as.magicblock.app": "https://devnet-as.magicblock.app",
  "devnet-eu.magicblock.app": "https://devnet-eu.magicblock.app",
  "devnet-us.magicblock.app": "https://devnet-us.magicblock.app",
  "localhost:7799": "http://localhost:7799",
};

export const VALIDATOR_PUBKEYS: Record<string, string> = {
  "mainnet-tee.magicblock.app": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  "devnet-tee.magicblock.app": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  "as.magicblock.app": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  "eu.magicblock.app": "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  "us.magicblock.app": "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
  "devnet-as.magicblock.app": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  "devnet-eu.magicblock.app": "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  "devnet-us.magicblock.app": "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
  "localhost:7799": "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
};

/**
 * Validate and resolve a validator identifier to its endpoint and pubkey.
 * Throws an error if the validator is unknown.
 */
export function getValidatorEndpoint(validator: string): string {
  const endpoint = VALIDATOR_ENDPOINTS[validator];
  if (!endpoint) {
    throw new Error(`Unknown validator: ${validator}`);
  }
  return endpoint;
}

export function getValidatorPubkey(validator: string): string {
  const pubkey = VALIDATOR_PUBKEYS[validator];
  if (!pubkey) {
    throw new Error(`Unknown validator: ${validator}`);
  }
  return pubkey;
}

/**
 * List all available validators
 */
export function getAvailableValidators(): string[] {
  return Object.keys(VALIDATOR_ENDPOINTS);
}

/**
 * Validate a validator string
 */
export function isValidValidator(validator: string): boolean {
  return validator in VALIDATOR_ENDPOINTS && validator in VALIDATOR_PUBKEYS;
}

/**
 * Get the default validator (used when not specified)
 */
export function getDefaultValidator(): string {
  return "devnet-tee.magicblock.app";
}

/**
 * Resolve validator with fallback to default
 */
export function resolveValidator(validator?: string): string {
  const resolved = validator ?? getDefaultValidator();
  if (!isValidValidator(resolved)) {
    throw new Error(`Unknown validator: ${resolved}`);
  }
  return resolved;
}
