/**
 * Images the card paints, only ever from the platform's own API (same origin,
 * so the canvas stays exportable): the profile picture from
 * GET /influencers/:id/avatar (a guarded fetch of the stored X CDN URL — never
 * a third-party avatar service), and a template's logo / background from
 * GET /influencers/card-templates/assets/:id (validated PNG/JPEG/WebP). Any
 * failure resolves to null: the card draws the initials fallback or leaves the
 * image out.
 */
import { getToken, refreshSession } from '../api';
import defaultLogo from '../../assets/brand/ithra-horizontal-negative.png?url';
import nhcLogo from '../../assets/brand/nhc-full-negative.png?url';
import nhcVines from '../../assets/brand/nhc-footer-vines.png?url';

const TIMEOUT_MS = 8_000;
const ALLOWED = /^image\/(jpeg|png|webp)$/;

async function fetchImage(path: string, retry = true): Promise<Blob | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const token = getToken();
    const res = await fetch(path, { credentials: 'include', signal: ctrl.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.status === 401 && retry && (await refreshSession())) return fetchImage(path, false);
    if (!res.ok) return null;
    const blob = await res.blob();
    return ALLOWED.test(blob.type) ? blob : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function decode(path: string): Promise<ImageBitmap | null> {
  const blob = await fetchImage(path);
  if (!blob) return null;
  try { return await createImageBitmap(blob); } catch { return null; }
}

/** The decoded avatar, or null. Only the API's own avatar path is accepted. */
export function loadCardAvatar(path: string | null): Promise<ImageBitmap | null> {
  if (!path || !/^\/api\/v1\/influencers\/[0-9a-f-]{36}\/avatar$/.test(path)) return Promise.resolve(null);
  return decode(path);
}

/** A template image (logo or background) by asset id, or null. */
export function loadCardAsset(id: string | null): Promise<ImageBitmap | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return Promise.resolve(null);
  return decode(`/api/v1/influencers/card-templates/assets/${id}`);
}
/** The bundled logo a template uses when it names none: NHC for the NHC style, the platform's otherwise. */
export const loadDefaultCardLogo = (style: 'classic' | 'nhc' = 'classic') => decode(style === 'nhc' ? nhcLogo : defaultLogo);

/** The NHC vine strip drawn under the card when the footer pattern is «vines» (bundled, same origin). */
export const loadFooterVines = () => decode(nhcVines);

export interface CardImages { avatar: CanvasImageSource | null; logo?: CanvasImageSource | null; background?: CanvasImageSource | null; footer?: CanvasImageSource | null }
