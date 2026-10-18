/** A retry may only identify the same immutable request, not just the same account/format. */
const fields = ['influencer_id', 'format', 'png_scale', 'program_id', 'program_filter_id', 'template_id',
  'template_version', 'builtin_template', 'range_preset', 'range_from', 'range_to', 'scope', 'recent_limit'] as const;
export function sameExportRequest(previous: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return fields.every(key => {
    if (key === 'range_from' || key === 'range_to') {
      const a = new Date(previous[key] as string | Date).getTime();
      const b = new Date(expected[key] as string | Date).getTime();
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    }
    return (previous[key] ?? null) === (expected[key] ?? null);
  });
}
