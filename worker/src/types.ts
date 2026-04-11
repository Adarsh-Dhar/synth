export interface Agent {
  id: string;
  name: string;
  status: string;
  strategy: string;
  targetPair: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TradeAction = "BUY" | "SELL";

export interface WebhookPayload {
  agentId: string;
  action: TradeAction;
  txHash: string;
  profit: number;
  price: number;
  message: string;
}

export interface TradeResult {
  txHash: string;
  success: boolean;
  error?: string;
}

export interface PriceData {
  pair: string;
  price: number;
  timestamp: number;
  volume24h?: number;
  priceChange24h?: number;
}