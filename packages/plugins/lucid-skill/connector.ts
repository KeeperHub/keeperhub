// Bounty contribution: Lucid-skill -> KeeperHub listing schema.
// Drop into KeeperHub/keeperhub as packages/plugins/lucid-skill/connector.ts
import { z } from 'zod';

export const lucidSkillSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(10).max(280),
  inputSchema: z.record(z.unknown()),
  priceUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  chainId: z.enum(['84532', '11155111', '8453', '1']),
  keeperWorkflowId: z.string().min(3),
  facilitatorUrl: z.string().url().optional(),
  erc8004: z.object({ registerReputation: z.boolean().default(true) }).default({}),
});

export type LucidSkill = z.infer<typeof lucidSkillSchema>;

export function toPerWorkflowMcpUrl(base: string, slug: string): string {
  return `${base.replace(/\/mcp\/?$/, '')}/mcp/w/${slug}`;
}

export function assertPayableChallenge(
  challenge: { priceUsdc?: string; token?: string; chainId?: string; slug?: string },
  capUsdc: number,
): void {
  const price = Number(challenge.priceUsdc ?? NaN);
  if (!Number.isFinite(price) || price <= 0) throw new Error('402 missing price');
  if ((challenge.token ?? 'USDC').toUpperCase() !== 'USDC') throw new Error('non-USDC 402');
  if (!['84532', '11155111', '8453', '1'].includes(String(challenge.chainId ?? '')))
    throw new Error('unexpected 402 chain');
  if (price > capUsdc) throw new Error(`402 price $${price} exceeds cap $${capUsdc}`);
  if (!challenge.slug) throw new Error('402 not slug-bound');
}
