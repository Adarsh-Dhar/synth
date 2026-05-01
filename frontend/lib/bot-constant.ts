/**
 * Bot intent and env configuration (Solana-first migration).
 *
 * This file uses only SOLANA_* environment variables and Solana-compatible default fields.
 */
 
export interface BotIntent {
  chain?: "solana";
  network?: string;
  execution_model?: "polling" | "agentic";
  strategy?: string;
  dataProvider?: "goldrush" | "rpc";
  privateExecution?: boolean;
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
  GOLDRUSH_API_KEY?: string;
  GOLDRUSH_STREAM_URL?: string;
  GOLDRUSH_STREAM_EVENTS?: string;
  GOLDRUSH_MCP_URL?: string;
  MAGICBLOCK_TEE_VALIDATOR?: string;
  MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL?: string;
  UMBRA_PROGRAM_ADDRESS?: string;
  UMBRA_NETWORK?: string;
  DODO_PLAN_PRO_ID?: string;
  DODO_WEBHOOK_SECRET?: string;
  DODO_DOCS_MCP_URL?: string;
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
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
  SOLANA_NETWORK: "mainnet-beta",
  SOLANA_USDC_MINT: "",
  GOLDRUSH_API_KEY: "",
  GOLDRUSH_STREAM_URL: "",
  GOLDRUSH_STREAM_EVENTS: "lp_pull,drainer_approval,phishing_airdrop",
  GOLDRUSH_MCP_URL: "",
  MAGICBLOCK_TEE_VALIDATOR: "",
  MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL: "",
  UMBRA_PROGRAM_ADDRESS: "",
  UMBRA_NETWORK: "mainnet-beta",
  DODO_PLAN_PRO_ID: "",
  DODO_WEBHOOK_SECRET: "",
  DODO_DOCS_MCP_URL: "http://127.0.0.1:5002",
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
  const useGoldRush = intent?.dataProvider === "goldrush" || mcps.includes("goldrush");
  const useMagicBlock = Boolean(intent?.privateExecution) || strategy.includes("private") || mcps.includes("magicblock");
  const useUmbra = strategy.includes("shield") || strategy.includes("anonymous") || mcps.includes("umbra");
  const useDodo = strategy.includes("meter") || strategy.includes("payment") || strategy.includes("split") || mcps.includes("dodo");

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
      placeholder: "http://127.0.0.1:8899",
      helpText: "RPC endpoint for Solana cluster (mainnet-beta fork).",
    },
    {
      key: "SOLANA_NETWORK",
      label: "Solana Network",
      type: "text",
      required: false,
      placeholder: "mainnet-beta",
      helpText: "Solana network identifier (mainnet-beta).",
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
        placeholder: "Enter USDC mint address (mainnet)",
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

  if (useGoldRush) {
    fields.push(
      {
        key: "GOLDRUSH_API_KEY",
        label: "GoldRush API Key",
        type: "password",
        required: true,
        placeholder: "gr_...",
      },
      {
        key: "GOLDRUSH_STREAM_URL",
        label: "GoldRush Stream URL",
        type: "text",
        required: false,
        placeholder: "wss://api.goldrush.dev/graphql",
      },
      {
        key: "GOLDRUSH_STREAM_EVENTS",
        label: "GoldRush Stream Events",
        type: "text",
        required: false,
        placeholder: "lp_pull,drainer_approval,phishing_airdrop",
        helpText: "Comma-separated event types the bot should react to.",
      },
      {
        key: "GOLDRUSH_MCP_URL",
        label: "GoldRush MCP URL",
        type: "text",
        required: true,
        placeholder: "https://goldrush-mcp.example.com/mcp",
        helpText: "MCP endpoint used by generated bot tools for GoldRush queries.",
      },
    );
  }

  if (useMagicBlock) {
    fields.push(
      {
        key: "MAGICBLOCK_TEE_VALIDATOR",
        label: "MagicBlock TEE Validator",
        type: "text",
        required: true,
        placeholder: "mainnet-tee.magicblock.app",
      },
      {
        key: "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL",
        label: "MagicBlock Private Payments API",
        type: "text",
        required: true,
        placeholder: "https://api.magicblock.gg/private-payments",
      },
    );
  }

  if (useUmbra) {
    fields.push(
      {
        key: "UMBRA_PROGRAM_ADDRESS",
        label: "Umbra Program Address",
        type: "text",
        required: true,
        placeholder: "UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh",
      },
      {
        key: "UMBRA_NETWORK",
        label: "Umbra Network",
        type: "text",
        required: true,
        placeholder: "mainnet-beta",
      },
    );
  }

  if (useDodo) {
    fields.push(
      {
        key: "DODO_PLAN_PRO_ID",
        label: "Dodo Plan ID",
        type: "text",
        required: true,
        placeholder: "plan_pro_xxx",
      },
      {
        key: "DODO_WEBHOOK_SECRET",
        label: "Dodo Webhook Secret",
        type: "password",
        required: true,
        placeholder: "whsec_...",
      },
      {
        key: "DODO_DOCS_MCP_URL",
        label: "Dodo Docs MCP URL",
        type: "text",
        required: false,
        placeholder: "http://127.0.0.1:5002",
      },
    );
  }

  return fields;
}
