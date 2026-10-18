import { sql } from '@mip/db';
import type { FieldSelection, Pricing } from './types.js';

/**
 * Pricing, limits and field selection all come from the settings table.
 * Nothing here is hard-coded, so an X pricing change is a row edit — not a
 * redeploy (docs/PROJECT_PLAN.md §46).
 */
async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await sql<{ value: T }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return rows[0]?.value ?? fallback;
}

export async function getPricing(): Promise<Pricing> {
  const p = await getSetting('x_api.pricing', {
    model: 'subscription_with_quota',
    monthly_price_usd: 200,
    monthly_post_quota: 10000,
    derived_unit_price_usd: 0.02,
  } as Record<string, number | string>);

  const monthlyPriceUsd = Number(p.monthly_price_usd ?? 0);
  const monthlyPostQuota = Number(p.monthly_post_quota ?? 0);

  // Derive rather than trust the stored derived value: if someone edits the
  // price but forgets the derived field, the derived one would be stale.
  const unitPrice =
    monthlyPostQuota > 0
      ? monthlyPriceUsd / monthlyPostQuota
      : Number(p.derived_unit_price_usd ?? 0);

  return { unitPrice, monthlyPriceUsd, monthlyPostQuota, model: String(p.model ?? 'unknown') };
}

export async function getFieldSelection(): Promise<FieldSelection> {
  const f = await getSetting('x_api.fields', {} as Record<string, string[]>);
  return {
    tweetFields: f['tweet.fields'] ?? ['id', 'text', 'created_at', 'author_id', 'lang', 'public_metrics'],
    userFields: f['user.fields'] ?? ['id', 'username', 'name', 'public_metrics'],
    expansions: f['expansions'] ?? ['author_id'],
    mediaFields: f['media.fields'] ?? [],
  };
}

export async function getLimits() {
  return getSetting('x_api.limits', {
    search_recent_requests_per_15min: 60,
    max_results_per_request: 100,
    search_window_days: 7,
  });
}
