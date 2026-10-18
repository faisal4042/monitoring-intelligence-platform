/** Client for /influencers/card-templates (apps/api/src/modules/influencer-cards/routes.ts). */
import type { CardTemplateConfig } from '@mip/shared';
import { api, getToken, refreshSession, ApiError } from '../api';
import { validateCardAssetFile } from './upload-policy';

export interface TemplateSummary {
  id: string; name: string; description: string | null; program_id: string | null; program_name: string | null;
  status: 'active' | 'disabled'; is_default: boolean; draft_revision: number; published_version: number | null;
  created_at: string; updated_at: string; updated_by_name: string | null; has_unpublished_changes: boolean;
}
export interface TemplateVersionSummary { version: number; schema_version: number; config_sha256: string; note: string | null; published_at: string; published_by_name: string | null }
export interface TemplateDetail extends TemplateSummary { draft_config: CardTemplateConfig; versions: TemplateVersionSummary[] }
export interface TemplateVersion extends TemplateVersionSummary { template_id: string; config: CardTemplateConfig }
export interface CardAsset { id: string; kind: 'logo' | 'background'; mime: string; width: number; height: number; byte_size: number; original_name: string | null; created_at: string }
export type ResolvedTemplate =
  | { source: 'template'; activated: true; template: { id: string; name: string; version: number; program_id: string | null }; config: CardTemplateConfig }
  | { source: 'builtin'; activated: boolean; template: null; config: CardTemplateConfig };
export interface PublishedTemplate { id: string; name: string; program_id: string | null; program_name: string | null; published_version: number; is_default: boolean }

const B = '/influencers/card-templates';
export const templatesApi = {
  list: (signal?: AbortSignal) => api.get<{ items: TemplateSummary[] }>(B, signal),
  get: (id: string, signal?: AbortSignal) => api.get<TemplateDetail>(`${B}/${id}`, signal),
  version: (id: string, v: number, signal?: AbortSignal) => api.get<TemplateVersion>(`${B}/${id}/versions/${v}`, signal),
  create: (body: { name: string; description?: string | null; programId?: string | null; config?: CardTemplateConfig }) => api.post<TemplateDetail>(B, body),
  update: (id: string, body: { revision: number; name?: string; description?: string | null; programId?: string | null; config?: CardTemplateConfig }) =>
    api.patch<TemplateDetail>(`${B}/${id}`, body),
  publish: (id: string, revision: number, note?: string) => api.post<TemplateDetail>(`${B}/${id}/publish`, { revision, ...(note ? { note } : {}) }),
  duplicate: (id: string) => api.post<TemplateDetail>(`${B}/${id}/duplicate`, {}),
  restore: (id: string, revision: number, version: number) => api.post<TemplateDetail>(`${B}/${id}/restore`, { revision, version }),
  setDefault: (id: string, isDefault: boolean) => api.post<TemplateDetail>(`${B}/${id}/default`, { isDefault }),
  setStatus: (id: string, status: 'active' | 'disabled') => api.post<TemplateDetail>(`${B}/${id}/status`, { status }),
  assets: (signal?: AbortSignal) => api.get<{ items: CardAsset[] }>(`${B}/assets`, signal),
  resolve: (q: { program?: string | null; templateId?: string | null }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (q.program) p.set('program', q.program);
    if (q.templateId) p.set('templateId', q.templateId);
    return api.get<ResolvedTemplate>(`${B}/resolve${p.size ? `?${p}` : ''}`, signal);
  },
  published: (signal?: AbortSignal) => api.get<{ activated: boolean; items: PublishedTemplate[] }>(`${B}/published`, signal),
};

/**
 * Uploads an identity image. The browser re-encodes it to PNG through a canvas first
 * (dropping metadata and anything that is not pixels); the server validates it again.
 */
export async function uploadCardAsset(file: File, kind: 'logo' | 'background'): Promise<CardAsset> {
  validateCardAssetFile(file);
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('المسموح PNG أو JPEG أو WebP فقط');
  if (file.size > 4 * 1024 * 1024) throw new Error('حجم الملف كبير جداً (الحد قبل التحويل 4 ميغابايت)');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('تعذّر قراءة الصورة'); });
  const max = 1600;
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k)); canvas.height = Math.max(1, Math.round(bitmap.height * k));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('تعذّر تحويل الصورة'))), 'image/png'));
  const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  const send = async (retry = true): Promise<CardAsset> => {
    const token = getToken();
    const res = await fetch(`/api/v1${B}/assets`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // Canvas re-encodes to PNG; the submitted name must match the resulting bytes.
      body: JSON.stringify({ kind, fileName: file.name.replace(/\.[^.]+$/, '').slice(0, 190) + '.png', data }),
    });
    if (res.status === 401 && retry && (await refreshSession())) return send(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code);
    return body as CardAsset;
  };
  return send();
}
