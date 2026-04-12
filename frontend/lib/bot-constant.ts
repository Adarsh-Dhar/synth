/**
 * Bot intent and env configuration (Solana-first migration).
 *
 * This file uses only SOLANA_* environment variables and Solana-compatible default fields.
 */

  chain?: "solana";
  network?: string;
  execution_model?: "polling" | "agentic";
  strategy?: string;
  mcps?: string[];
  bot_name?: string;
  requires_openai?: boolean;
  required_mcps?: string[];
  bot_type?: string;
  requires_openai_key?: boolean;
}

export interface BotEnvConfig {
  SIMULATION_MODE: string;
  MCP_GATEWAY_URL: string;
  SIGNING_RELAY_BASE: string;
  SESSION_KEY_MODE: string;
  // Solana-specific
  SOLANA_KEY?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_NETWORK?: string;
  SOLANA_USDC_MINT?: string;
  // Generic
  USER_WALLET_ADDRESS: string;
  RECIPIENT_ADDRESS?: string;
  KEYPAIR_PATH?: string;
  // Removed Solana keys
  // Other optional fields
  OPENAI_API_KEY?: string;
  POLL_INTERVAL?: string;
  [key: string]: string | undefined;
}

export const DEFAULT_BOT_ENV_CONFIG: BotEnvConfig = {
  SIMULATION_MODE: "false",
  MCP_GATEWAY_URL: "http://192.168.1.50:8000/mcp",
  SIGNING_RELAY_BASE: "",
  SESSION_KEY_MODE: "false",
  SOLANA_KEY: "",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  SOLANA_NETWORK: "devnet",
  SOLANA_USDC_MINT: "",
  USER_WALLET_ADDRESS: "",
  RECIPIENT_ADDRESS: "",
  KEYPAIR_PATH: "",
  // Removed Solana keys
  OPENAI_API_KEY: "",
  POLL_INTERVAL: "15",
};

export interface EnvFieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "toggle";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  helpLink?: string;
  helpLinkLabel?: string;
}

export const BOT_NPMRC = "fund=false\naudit=false\n";

export function getRequiredEnvFields(
  intent?: BotIntent | null,
  options?: { sessionKeyMode?: boolean },
): EnvFieldDef[] {
  const strategy = (intent?.strategy ?? "").toLowerCase();
  const botName = (intent?.bot_name ?? intent?.bot_type ?? "").toLowerCase();
  const sessionKeyMode = options?.sessionKeyMode ?? false;
  const mcps = Array.from(
    new Set([
      ...((intent?.mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
      ...((intent?.required_mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
    ]),
  );

  const isYield = strategy.includes("yield") || /sweep|consolidator/.test(botName);
  const isSpreadScanner = botName.includes("spread") && botName.includes("scanner");
  const isArbitrage = strategy.includes("arbitrage") || /arbitrage/.test(botName);

  const fields: EnvFieldDef[] = [
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      type: "text",
      required: true,
      placeholder: "http://192.168.1.50:8000/mcp",
      helpText: "URL of the running Meta-Agent gateway.",
    },
    {
      key: "SIGNING_RELAY_BASE",
      label: "Signing Relay Base URL",
      type: "text",
      required: false,
      placeholder: "http://localhost:3000",
      helpText: "Base URL for /api/signing-relay. Leave blank to auto-use browser origin.",
    },
    {
      key: "SIMULATION_MODE",
      label: "Execution Mode",
      type: "toggle",
      required: false,
      placeholder: "true",
      helpText: "Simulation mode avoids sending real transactions.",
    },
    {
      key: "SOLANA_RPC_URL",
      label: "Solana RPC URL",
      type: "text",
      required: false,
      placeholder: "https://api.devnet.solana.com",
      helpText: "RPC endpoint for Solana cluster (devnet/mainnet).",
    },
    {
      key: "SOLANA_NETWORK",
      label: "Solana Network",
      type: "text",
      required: false,
      placeholder: "devnet",
      helpText: "Solana network identifier (devnet/mainnet).",
    },
  ];

  if (isYield) {
    fields.push(
      {
        key: "USER_WALLET_ADDRESS",
        label: "User Wallet Address",
        type: "text",
        required: true,
        placeholder: "YourBase58AddressHere",
        helpText: "Your Solana wallet address (base58).",
      },
      {
        key: "RECIPIENT_ADDRESS",
        label: "Recipient Address",
        type: "text",
        required: false,
        placeholder: "RecipientBase58",
        helpText: "Where swept funds will be sent (base58).",
      },
      {
        key: "KEYPAIR_PATH",
        label: "Server Keypair Path",
        type: "text",
        required: false,
        placeholder: "./keypair.json",
        helpText: "Optional local keypair JSON for server-side signing.",
      },
    );
  }

  if (isSpreadScanner || isArbitrage) {
    fields.push(
      {
        key: "SOLANA_USDC_MINT",
        label: "USDC Mint Address",
        type: "text",
        required: true,
        placeholder: "Enter USDC mint address (mainnet/devnet)",
        helpText: "SPL token mint address for USDC used by the bot.",
      },
      {
        key: "POLL_INTERVAL",
        label: "Poll Interval (seconds)",
        type: "text",
        required: false,
        placeholder: "15",
      },
    );
  }

  if (strategy.includes("liquidation")) {
    fields.push(
      {
        key: "SOLANA_USDC_MINT",
        label: "USDC Mint Address",
        type: "text",
        required: true,
        placeholder: "USDC mint address",
        helpText: "SPL token mint address used for liquidation checks.",
      },
    );
  }

  if (intent?.requires_openai ?? intent?.requires_openai_key) {
    fields.push({
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      type: "password",
      required: true,
      placeholder: "sk-...",
    });
  }

  return fields;
}
