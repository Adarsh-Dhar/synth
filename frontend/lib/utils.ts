import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ChatMessage } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const uid = () => Math.random().toString(36).slice(2)
 
export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
 
export const strategyLabel = (s: string) =>
  s === 'MEME_SNIPER'  ? 'Meme Token Sniper'
  : s === 'ARBITRAGE'  ? 'Arbitrage Bot'
  : 'Social Sentiment Trader'
 
export const confidenceColor = (c: string) =>
  c === 'HIGH' ? 'bg-green-500/20 text-green-300 border-green-500/30'
  : c === 'LOW' ? 'bg-red-500/20 text-red-300 border-red-500/30'
  : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
 
export function makeAssistantMsg(
  content: string,
  card?: ChatMessage['card'],
): ChatMessage {
  return { id: uid(), role: 'assistant', content, timestamp: new Date(), card }
}
 
export function makeUserMsg(content: string): ChatMessage {
  return { id: uid(), role: 'user', content, timestamp: new Date() }
}

export function parseFilesToTree(files: any[]): Record<string, any> {
  const tree: Record<string, any> = {};
  for (const file of files) {
    const path = file.filepath || file.path || file.filename;
    let content = file.content ?? file.code ?? file.contents ?? "";
    if (!path) continue;
    if (typeof content === "object" && content !== null) {
      content = JSON.stringify(content, null, 2);
    } else if (typeof content === "string") {
      content = content.replace(/^\s*```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
    }
    const cleanPath = path.replace(/^[./]+/, "");
    const parts = cleanPath.split("/");
    let cur: any = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      if (i === parts.length - 1) {
        cur[part] = { file: { contents: String(content) } };
      } else {
        if (!cur[part]) cur[part] = { directory: {} };
        else if (cur[part].file) cur[part] = { directory: {} };
        cur = cur[part].directory;
      }
    }
  }
  return tree;
}