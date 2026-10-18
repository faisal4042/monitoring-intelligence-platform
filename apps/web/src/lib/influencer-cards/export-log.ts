/**
 * The logged export flow (apps/api/src/modules/influencer-cards/exports.ts):
 *   request → make the file here → record `generated` (pages, size, SHA-256) or `failed`
 *   → hand the file to the browser → record `handed_to_browser`.
 * Once the log is activated (0048), no file is handed over unless its request and its `generated`
 * outcome were recorded. "Saved on the device" is never claimed: the browser cannot prove it.
 * Before 0048 the export runs as before, without a log.
 */
import { api, ApiError } from '../api';
import { CardFontError } from './fonts';

export interface ExportPolicy { activated: boolean; requiresPermission: boolean; permission: string; allowed: boolean }
export interface ExportRequest {
  influencerId: string; format: 'png' | 'a4-portrait' | 'a4-landscape'; pngScale?: 2 | 3;
  range?: string; from?: string; to?: string; program?: string; scope: 'all' | 'relevant'; limit: number; templateId?: string;
  expected: { source: 'template' | 'builtin'; templateId?: string; version?: number };
}
export interface ExportLogItem {
  id: string; requested_at: string; format: string; png_scale: number | null; scope: string; recent_limit: number;
  range_preset: string | null; range_from: string; range_to: string; builtin_template: boolean; template_id: string | null;
  template_version: number | null; template_name: string | null; program_id: string | null; program_name: string | null;
  influencer_id: string; username: string; requested_by: string; requested_by_name: string;
  status: 'requested' | 'generated' | 'failed'; outcome_at: string | null; pages: number | null; file_bytes: number | null;
  error_code: string | null; handed_to_browser_at: string | null;
}

const B = '/influencers/card-exports';
export const exportLogApi = {
  policy: (signal?: AbortSignal) => api.get<ExportPolicy>(`${B}/policy`, signal),
  request: (body: ExportRequest & { idempotencyKey: string }) =>
    api.post<{ exportId: string; requestedAt: string; template: ExportRequest['expected']; replay: boolean }>(B, body),
  event: (exportId: string, body: Record<string, unknown>) => api.post<{ exportId: string; event: string }>(`${B}/${exportId}/events`, body),
  list: (q: { all?: boolean; influencerId?: string; page?: number }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (q.all) p.set('all', 'true');
    if (q.influencerId) p.set('influencerId', q.influencerId);
    if (q.page) p.set('page', String(q.page));
    return api.get<{ items: ExportLogItem[]; total: number; page: number; pageSize: number }>(`${B}${p.size ? `?${p}` : ''}`, signal);
  },
};

/** `range=30d` / `from=…&to=…` → request fields. */
export function periodFields(apiQuery: string) {
  const p = new URLSearchParams(apiQuery);
  return Object.fromEntries(['range', 'from', 'to'].filter((k) => p.get(k)).map((k) => [k, p.get(k)!])) as { range?: string; from?: string; to?: string };
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short, non-personal code for a failure; never the message text. */
function failureCode(e: unknown) {
  if (e instanceof CardFontError) return 'FONT_UNAVAILABLE';
  const m = (e as Error)?.message ?? '';
  if (/أطول من أن تُحفظ|too large/i.test(m)) return 'OUTPUT_TOO_LARGE';
  if (/Canvas/i.test(m)) return 'CANVAS_UNAVAILABLE';
  return 'RENDER_FAILED';
}

export type LoggedExportResult =
  | { logged: false }
  | { logged: true; exportId: string; handedToBrowser: boolean };

/**
 * Runs one export. `make` produces the file; `deliver` hands it to the browser.
 * Throws ApiError TEMPLATE_CHANGED when the published template moved since the preview (redraw, then retry).
 */
export async function runLoggedExport(opts: {
  policy: ExportPolicy | undefined; request: ExportRequest; pages: number;
  make: () => Promise<Blob>; deliver: (blob: Blob) => void;
}): Promise<LoggedExportResult> {
  // An unknown policy never means "no log": refuse rather than export unrecorded.
  if (!opts.policy) throw new Error('تعذّر التحقق من سياسة التصدير؛ لم يُصدَّر شيء.');
  if (!opts.policy.allowed) throw new Error(`التصدير يتطلب صلاحية ${opts.policy.permission}.`);
  if (!opts.policy.activated) {
    opts.deliver(await opts.make());
    return { logged: false };
  }
  const { exportId } = await exportLogApi.request({ ...opts.request, idempotencyKey: crypto.randomUUID().replace(/-/g, '') });
  const started = performance.now();
  let blob: Blob;
  try {
    blob = await opts.make();
  } catch (e) {
    await exportLogApi.event(exportId, { event: 'failed', errorCode: failureCode(e), durationMs: Math.round(performance.now() - started) }).catch(() => {});
    throw e;
  }
  // The outcome is on record before the file leaves this page.
  await exportLogApi.event(exportId, {
    event: 'generated', pages: opts.pages, fileBytes: blob.size, fileSha256: await sha256(blob), durationMs: Math.round(performance.now() - started),
  });
  opts.deliver(blob);
  const handed = await exportLogApi.event(exportId, { event: 'handed_to_browser' }).then(() => true, () => false);
  return { logged: true, exportId, handedToBrowser: handed };
}

export const isTemplateChanged = (e: unknown) => e instanceof ApiError && e.code === 'TEMPLATE_CHANGED';
