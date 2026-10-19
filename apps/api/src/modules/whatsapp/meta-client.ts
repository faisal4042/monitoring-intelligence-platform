/**
 * Minimal client for the official WhatsApp Business Platform Cloud API (Graph API).
 * Only three calls: send a template message, read the phone number (verification
 * without sending), and list the account's templates with their review status.
 * The access token travels only in the Authorization header and is never logged.
 */
import { classifyMetaError, classifyNetworkError, type ClassifiedError, type MetaErrorBody } from './errors.js';

export interface MetaCredentials {
  baseUrl: string;
  apiVersion: string;
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
}

export type MetaResult<T> = { ok: true; data: T } | { ok: false; error: ClassifiedError };

export interface PhoneNumberInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  rejected_reason?: string;
  components?: Array<{ type: string; text?: string }>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;

async function call<T>(fetchImpl: Fetch, cred: MetaCredentials, method: 'GET' | 'POST', path: string, body?: unknown): Promise<MetaResult<T>> {
  const url = `${cred.baseUrl.replace(/\/$/, '')}/${cred.apiVersion}/${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${cred.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: classifyNetworkError(err) };
  }
  const parsed = (await res.json().catch(() => null)) as (T & MetaErrorBody) | null;
  if (!res.ok || parsed?.error) return { ok: false, error: classifyMetaError(res.status, parsed, res.headers.get('retry-after')) };
  return { ok: true, data: parsed as T };
}

export function createMetaClient(cred: MetaCredentials, fetchImpl: Fetch = fetch) {
  return {
    /** POST /{phone-number-id}/messages with an approved template. Returns Meta's message id (wamid). */
    async sendTemplate(input: { to: string; templateName: string; language: string; bodyParams: string[] }): Promise<MetaResult<{ messageId: string }>> {
      const components = input.bodyParams.length
        ? [{ type: 'body', parameters: input.bodyParams.map((text) => ({ type: 'text', text })) }]
        : [];
      const r = await call<{ messages?: Array<{ id?: string }> }>(fetchImpl, cred, 'POST', `${cred.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to.replace(/^\+/, ''),
        type: 'template',
        template: { name: input.templateName, language: { code: input.language }, components },
      });
      if (!r.ok) return r;
      const id = r.data.messages?.[0]?.id;
      // A 200 without a message id is not an acceptance we can track: treat it as uncertain, never resend.
      if (!id) return { ok: false, error: { class: 'uncertain', code: 'no_message_id', message: 'ردّت Meta دون معرّف رسالة' } };
      return { ok: true, data: { messageId: id } };
    },

    /** GET /{phone-number-id}: proves the token, version and number id work, without sending anything. */
    getPhoneNumber(): Promise<MetaResult<PhoneNumberInfo>> {
      return call<PhoneNumberInfo>(fetchImpl, cred, 'GET', `${cred.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
    },

    /** GET /{waba-id}/message_templates (all pages, capped). Read-only. */
    async listTemplates(): Promise<MetaResult<MetaTemplate[]>> {
      const all: MetaTemplate[] = [];
      let path = `${cred.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100`;
      for (let page = 0; page < 10; page++) {
        const r = await call<{ data?: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(fetchImpl, cred, 'GET', path);
        if (!r.ok) return r;
        all.push(...(r.data.data ?? []));
        const after = r.data.paging?.next ? r.data.paging?.cursors?.after : undefined;
        if (!after) break;
        path = `${cred.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100&after=${encodeURIComponent(after)}`;
      }
      return { ok: true, data: all };
    },
  };
}
export type MetaClient = ReturnType<typeof createMetaClient>;
