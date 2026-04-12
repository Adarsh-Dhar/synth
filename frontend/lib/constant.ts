import { EnvConfig } from "./types";

export const VALID_STRATEGIES = ["MEME_SNIPER", "ARBITRAGE", "SENTIMENT_TRADER"] as const;

export const VALID_CONFIDENCE  = ["HIGH", "MEDIUM", "LOW"] as const;

export const ACTION_LOG_TYPE_MAP: Record<string, string> = {
  BUY:            "EXECUTION_BUY",
  SELL:           "EXECUTION_SELL",
  PROFIT_SECURED: "PROFIT_SECURED",
  ERROR:          "ERROR",
  INFO:           "INFO",
};

export const DEFAULT_ENV_CONFIG: EnvConfig = {
  SOLANA_RPC_URL:  "https://api.devnet.solana.com",
  SOLANA_KEY:      "",
  SOLANA_RPC_URL:  "",
  SOLANA_KEY:      "",
  CONTRACT_ADDRESS: "",
  MAX_LOAN_USD:    "10000",
  MIN_PROFIT_USD:  "50",
  DRY_RUN:         "true",
};

export const NPMRC_CONTENT = [
  "registry=https://registry.yarnpkg.com/",
  "maxsockets=2",
  "fetch-retries=5",
  "fetch-retry-mintimeout=20000",
  "fetch-retry-maxtimeout=120000",
  "fund=false",
  "audit=false",
].join("\n");

export const ENTRY_POINTS = [
  "src/agent/index.ts",
  "src/index.ts",
  "index.ts",
  "src/main.ts",
  "main.ts",
  "src/workflow.ts"
];

export const TOKEN_ADDRESSES = {
  WETH_ADDRESS: "",
  USDC_ADDRESS: "",
};

export const SUPPORTED_NETWORKS = [
  { id: 'solana-testnet', name: 'Solana Testnet', icon: '◇' },
  { id: 'solana-devnet', name: 'Solana Devnet', icon: '◎' },
]