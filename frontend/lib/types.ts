import { Agent } from "./api";
import { VALID_STRATEGIES, VALID_CONFIDENCE } from "./constant";

export type Role = 'assistant' | 'user' | 'system'

export interface ChatMessage {
  id:        string
  role:      Role
  content:   string
  timestamp: Date
  card?:     PlanCard | ConfirmCard | DeployedCard | ErrorCard
}

export interface PlanCard {
  type: 'plan'
  plan: AgentPlan
}

export interface ConfirmCard {
  type:       'confirm'
  plan:       AgentPlan
  guardrails: Guardrails
}

export interface DeployedCard {
  type:      'deployed'
  agentName: string
  agentId:   string
}

export interface ErrorCard {
  type:    'error'
  message: string
}

export interface AgentPlan {
  agentName:                 string
  strategy:                  'MEME_SNIPER' | 'ARBITRAGE' | 'SENTIMENT_TRADER'
  targetPair:                string
  description:               string
  entryConditions:           string[]
  exitConditions:            string[]
  riskNotes:                 string[]
  sessionDurationHours:      number
  recommendedSpendAllowance: number
  confidence:                'HIGH' | 'MEDIUM' | 'LOW'
  warnings:                  string[]
}

export interface Guardrails {
  spendAllowance:       number
  sessionDurationHours: number
  maxDailyLoss:         number
}

export type ConvState =
  | 'greeting'
  | 'collecting'
  | 'drafting'
  | 'reviewing_plan'
  | 'guardrails'
  | 'deploying'
  | 'deposit'
  | 'done'

  // Shared types for WebContainerRunner and related hooks/components

export interface GeneratedFile {
  filepath: string;
  content: string;
}

export interface EnvConfig {
  // Solana only
  SOLANA_RPC_URL?: string;
  SOLANA_KEY?: string;
  CONTRACT_ADDRESS?: string;
  MAX_LOAN_USD?: string;
  MIN_PROFIT_USD?: string;
  DRY_RUN?: string;
}

export type Phase = "idle" | "generating" | "env-setup" | "running";
export type Strategy   = typeof VALID_STRATEGIES[number];
export type Confidence = typeof VALID_CONFIDENCE[number];

export interface MissionPlan {
  agentName:                 string;
  strategy:                  Strategy;
  targetPair:                string;
  description:               string;
  entryConditions:           string[];
  exitConditions:            string[];
  riskNotes:                 string[];
  sessionDurationHours:      number;
  recommendedSpendAllowance: number;
  confidence:                Confidence;
  warnings:                  string[];
}

export interface CreateAgentRequestBody {
  userId:  string;
  intent:  string;           // natural language — required
  // optional overrides (from Tier 3 guardrails)
  spendAllowance?:      number;
  sessionDurationHours?: number;
  maxDailyLoss?:        number;
  // optional pre-generated session key (generated client-side or server-side)
  sessionKeyPub?:  string;
}

export type RouteContext = {
  params: Promise<{ agentId: string }>;
};

export interface AgentsTableProps {
  agents: Agent[]
  onRefresh?: () => void
}

/**
 * frontend/lib/bot-config-types.ts
 *
 * Types and constants for the Solana-only bot configurator.
 */

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const SUPPORTED_CHAINS = {
  "solana-devnet": { label: "Solana Devnet", chainId: "solana", rpcHint: "https://api.devnet.solana.com" },
} as const;

export type ChainKey = keyof typeof SUPPORTED_CHAINS;

  USDC: {
    label:    "USDC",
    address:  {
      "solana-devnet": "So11111111111111111111111111111111111111112", // Example USDC mint for Solana devnet
    },
    decimals: 6,
  },
};

  USDC: {
    label: "USDC",
    address: {
      "solana-devnet": "So11111111111111111111111111111111111111112",
    },
    decimals: 6,
  },
};

  solana: { label: "Solana", description: "Solana-native execution" },
} as const;

export type DexKey = keyof typeof SUPPORTED_DEXES;

  none:    { label: "None", description: "No external risk providers" },
} as const;

export type SecurityKey = keyof typeof SUPPORTED_SECURITY;

// ─── Bot Configuration Schema ─────────────────────────────────────────────────

export interface BotConfig {
  // Identity
  botName:          string;

  // Network
  chain:            ChainKey;

  // Assets
  baseToken:        string;   // e.g. "USDC"
  targetToken:      string;   // e.g. "WETH"

  // Protocols
  dex:              DexKey;
  securityProvider: SecurityKey;

  // Financial guardrails
  borrowAmountHuman: number;   // e.g. 1 (USDC)
  minProfitUsd:      number;   // e.g. 0.50
  gasBufferUsdc:     number;   // e.g. 2

  // Operational
  pollingIntervalSec: number;  // e.g. 5
  simulationMode:     boolean;

  oneInchApiKey?: string;
  webacyApiKey?: string;
  rpcUrl?: string;      // Optional custom RPC URL (if not using defaults)
  privateKey?: string; // Optional private key (if not generated server-side)

  // Optional: max risk score (0-100) from Webacy
  maxRiskScore: number;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  botName:            "SolanaBot",
  chain:              "solana-devnet",
  baseToken:          "USDC",
  targetToken:        "USDC",
  dex:                "solana",
  securityProvider:   "none",
  borrowAmountHuman:  1,
  minProfitUsd:       0.0,
  gasBufferUsdc:      0,
  pollingIntervalSec: 15,
  simulationMode:     true,
  maxRiskScore:       20,
};

// ─── Chat conversation steps ──────────────────────────────────────────────────

export type BotConfigStep =
  | "greeting"
  | "ask_chain"
  | "ask_base_token"
  | "ask_target_token"
  | "ask_dex"
  | "ask_security"
  | "ask_borrow_amount"
  | "ask_min_profit"
  | "ask_polling"
  | "ask_sim_mode"
  | "ask_bot_name"
  | "ask_credentials"
  | "review"
  | "generating"
  | "done"
  | "error";

export interface BotConfigChatMessage {
  id:        string;
  role:      "assistant" | "user";
  content:   string;
  timestamp: Date;
  card?:     BotConfigCard;
}

export type BotConfigCard =
  | { type: "chain_picker";    options: string[] }
  | { type: "token_picker";    options: string[]; label: string }
  | { type: "dex_picker";      options: string[] }
  | { type: "security_picker"; options: string[] }
  | { type: "number_input";    field: keyof BotConfig; label: string; placeholder: string; min: number; step: number }
  | { type: "bool_toggle";     field: keyof BotConfig; label: string }
  | { type: "review_card";     config: BotConfig }
  | { type: "success_card";    agentId: string; botName: string }
  | { type: "credentials_form" };