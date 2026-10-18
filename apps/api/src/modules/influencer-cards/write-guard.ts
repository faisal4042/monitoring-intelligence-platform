/**
 * Every write of the card feature (templates, versions, images, export log)
 * passes here first.
 *
 * In the main checkout, worker fencing has two layers:
 *  - workerCheckpoint() (apps/api/src/startup/worker-ownership.ts): a
 *    cooperative, process-level check that this process still holds an active
 *    ownership; it fails fast before any statement is sent;
 *  - the 0046 database guards (mip_fence_* triggers on every public table,
 *    including the 0048 tables): authoritative; a write from a session whose
 *    owner/epoch is not the active lease is refused with FENCE_* (SQLSTATE 55000).
 *
 * Missing ownership is also refused: the canonical checkpoint alone allows
 * an unbound process, so the feature first requires its official abort signal.
 * Database triggers remain authoritative if ownership changes after admission.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { workerAbortSignal, workerCheckpoint } from '../../startup/worker-ownership.js';
import { HttpError } from '../../lib/errors.js';

export async function beforeCardWrite(): Promise<void> {
  const signal = workerAbortSignal();
  if (!signal || signal.aborted) throw new HttpError(503, 'الكتابة متوقفة مؤقتًا لعدم توفر ملكية صالحة', 'WRITE_FENCED');
  try { await workerCheckpoint(); }
  catch { throw new HttpError(503, 'الكتابة متوقفة مؤقتًا لفقدان الملكية', 'WRITE_FENCED'); }
  if (signal.aborted) throw new HttpError(503, 'الكتابة متوقفة مؤقتًا لفقدان الملكية', 'WRITE_FENCED');
}

/** A write the fencing guards refused (this process does not hold the active lease). */
export function isFenceRefusal(err: unknown) {
  const e = err as { code?: string; message?: string };
  return e?.code === '55000' && /^FENCE_/.test(e.message ?? '');
}

/**
 * Error handler for the card plugins: an over-limit upload is a clear 413, a
 * fenced statement a clear 503; its whole cardMutation transaction (mutation
 * and audit together) is rolled back. A COMMIT whose outcome is unknown is
 * not retried and must be inspected. Anything else goes on to the app's
 * handler unchanged.
 */
export function cardErrorHandler(err: FastifyError, _req: FastifyRequest, reply: FastifyReply) {
  if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return reply.code(413).send({ error: 'حجم الملف يتجاوز الحد المسموح (1 ميغابايت)', code: 'PAYLOAD_TOO_LARGE' });
  if (isFenceRefusal(err))
    return reply.code(503).send({ error: 'الكتابة متوقفة: هذه العملية لا تملك حق الكتابة على قاعدة البيانات الآن (Fencing)', code: 'WRITE_FENCED' });
  throw err;
}
