export interface BulkItemResult { id: string; ok: boolean; error?: string }
/** Only explicit failures are safe to retry. Missing results have unknown outcomes. */
export function bulkOutcome(ids: readonly string[], results: readonly BulkItemResult[]) {
  const requested = [...new Set(ids)];
  const successful = requested.filter(id => results.some(r => r.id === id && r.ok));
  const failed = requested.filter(id => !successful.includes(id) && results.some(r => r.id === id && !r.ok && !!r.error && !r.error.includes('راجع سجل الإجراءات قبل إعادة المحاولة')));
  const unknown = requested.filter(id => !successful.includes(id) && !failed.includes(id));
  return { successful, failed, unknown };
}
