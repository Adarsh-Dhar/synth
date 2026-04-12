export interface BotConfig {
  botName: string;
  rpcUrl?: string;
  privateKey?: string;
  oneInchApiKey?: string;
  webacyApiKey?: string;
}

export type BotConfigStep =
  | "ask_bot_name"
  | "ask_credentials"
  | "review";

export type BotConfigCard =
  | { type: "sim_picker"; options: string[] }
  | { type: "credentials_form" }
  | { type: "summary"; config: any };
