/**
 * WhatsApp settings: one row (migration 0055). Secrets are stored encrypted and
 * never leave the server — the client sees "set / not set" and the last four
 * characters of the access token only.
 */
import { sql } from '@mip/db';
import { config } from '@mip/config';
import type { WhatsAppIntegrationState } from '@mip/shared';
import { decryptJson, encryptJson } from '../../lib/crypto.js';
import type { MetaCredentials } from './meta-client.js';

export interface SettingsRow {
  enabled: boolean; paused: boolean;
  waba_id: string | null; phone_number_id: string | null; api_version: string | null;
  access_token_encrypted: string | null; access_token_last4: string | null;
  app_secret_encrypted: string | null; verify_token_encrypted: string | null;
  display_phone_number: string | null; verified_name: string | null;
  max_per_minute: number; daily_limit: number | null; monthly_limit: number | null;
  max_attempts: number; backoff_base_seconds: number; backoff_max_seconds: number; retention_minutes: number;
  overdue_digest_minutes: number; negative_min_followers: number; news_failures_per_hour: number; quota_alert_percent: number;
  cost_estimate_per_message: string | null; cost_estimate_currency: string | null;
  last_verified_at: string | null; last_verified_ok: boolean | null;
  last_error_code: string | null; last_error_message: string | null; last_error_at: string | null;
  webhook_verified_at: string | null; last_webhook_at: string | null;
  updated_at: string;
}

let schemaReady: boolean | null = null;
let checkedAt = 0;
/** True once migration 0055 exists. Re-checked every minute so applying it needs no restart. */
export async function whatsappSchemaReady(): Promise<boolean> {
  if (schemaReady && Date.now() - checkedAt < 60_000) return true;
  if (schemaReady === false && Date.now() - checkedAt < 60_000) return false;
  const [row] = await sql<{ ok: boolean }[]>`SELECT to_regclass('public.whatsapp_settings') IS NOT NULL AS ok`;
  schemaReady = !!row?.ok; checkedAt = Date.now();
  return schemaReady;
}
/** Tests only: forget the cached answer. */
export function resetSchemaCache() { schemaReady = null; checkedAt = 0; }

export async function loadSettings(): Promise<SettingsRow> {
  const [row] = await sql<SettingsRow[]>`SELECT * FROM whatsapp_settings WHERE id`;
  if (!row) throw new Error('whatsapp_settings row missing');
  return row;
}

const secret = (enc: string | null): string | null => (enc ? decryptJson<{ v: string }>(enc).v : null);
export const encryptSecret = (value: string) => encryptJson({ v: value });

export function credentialsComplete(s: SettingsRow): boolean {
  return !!(s.waba_id && s.phone_number_id && s.api_version && s.access_token_encrypted);
}

/** Decrypted credentials for the Graph client, or null when the connection is not fully configured. */
export function credentialsFrom(s: SettingsRow): MetaCredentials | null {
  if (!credentialsComplete(s)) return null;
  return { baseUrl: config.WHATSAPP_GRAPH_BASE_URL, apiVersion: s.api_version!, accessToken: secret(s.access_token_encrypted)!, phoneNumberId: s.phone_number_id!, wabaId: s.waba_id! };
}
export const appSecretFrom = (s: SettingsRow) => secret(s.app_secret_encrypted);
export const verifyTokenFrom = (s: SettingsRow) => secret(s.verify_token_encrypted);

export function integrationState(s: SettingsRow): WhatsAppIntegrationState {
  if (!credentialsComplete(s)) return 'not_configured';
  // A known problem is shown even while the channel is disabled, so it is fixed before enabling.
  if (s.last_verified_ok === false || (s.last_error_at && (!s.last_verified_at || s.last_error_at > s.last_verified_at))) return 'error';
  if (!s.enabled) return 'disabled';
  if (s.paused) return 'paused';
  return 'ready';
}

/** What the client may see. No secret, ever — only whether each one is set. */
export function publicSettings(s: SettingsRow) {
  return {
    state: integrationState(s),
    enabled: s.enabled, paused: s.paused,
    serverSendingEnabled: config.WHATSAPP_ENABLED,
    wabaId: s.waba_id, phoneNumberId: s.phone_number_id, apiVersion: s.api_version,
    accessTokenSet: !!s.access_token_encrypted, accessTokenLast4: s.access_token_last4,
    appSecretSet: !!s.app_secret_encrypted, verifyTokenSet: !!s.verify_token_encrypted,
    displayPhoneNumber: s.display_phone_number, verifiedName: s.verified_name,
    webhookUrl: `${config.APP_URL.replace(/\/$/, '')}/api/v1/whatsapp/webhook`,
    webhookVerifiedAt: s.webhook_verified_at, lastWebhookAt: s.last_webhook_at,
    lastVerifiedAt: s.last_verified_at, lastVerifiedOk: s.last_verified_ok,
    lastErrorCode: s.last_error_code, lastErrorMessage: s.last_error_message, lastErrorAt: s.last_error_at,
    limits: {
      maxPerMinute: s.max_per_minute, dailyLimit: s.daily_limit, monthlyLimit: s.monthly_limit,
      maxAttempts: s.max_attempts, backoffBaseSeconds: s.backoff_base_seconds, backoffMaxSeconds: s.backoff_max_seconds,
      retentionMinutes: s.retention_minutes,
    },
    thresholds: {
      overdueDigestMinutes: s.overdue_digest_minutes, negativeMinFollowers: s.negative_min_followers,
      newsFailuresPerHour: s.news_failures_per_hour, quotaAlertPercent: s.quota_alert_percent,
    },
    costEstimate: s.cost_estimate_per_message === null ? null : { perMessage: Number(s.cost_estimate_per_message), currency: s.cost_estimate_currency },
    updatedAt: s.updated_at,
  };
}

/** Records the last error on the settings row (shown on the settings page; never contains a secret). */
export async function recordIntegrationError(code: string, message: string): Promise<void> {
  await sql`UPDATE whatsapp_settings SET last_error_code = ${code.slice(0, 60)}, last_error_message = ${message.slice(0, 500)}, last_error_at = now() WHERE id`;
}
