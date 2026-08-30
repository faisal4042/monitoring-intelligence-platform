import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeArabic } from '@mip/db';
import { classify } from './classifier.js';

const term = (value: string, type: string) => ({
  id: value,
  term: value,
  normalized: normalizeArabic(value),
  type,
});

test('rejects humanitarian rent requests that are not about a monitored program', () => {
  const result = classify(
    'عائلة متعففة ومحتاجين يدفعو الإيجار، التفاصيل الكامله dm',
    {
      negatives: [],
      positives: [term('دفع الإيجار', 'service')],
      sensitive: [],
    },
  );

  assert.equal(result.relevance, 'irrelevant');
  assert.equal(result.filterReason, 'out_of_scope_assistance');
});

test('does not hide a request that explicitly names the monitored program', () => {
  const result = classify(
    '@Ejar_Sa عائلة متعففة تحتاج مساعدة في دفع الايجار عبر المنصة',
    {
      negatives: [],
      positives: [term('@Ejar_Sa', 'primary')],
      sensitive: [],
    },
  );

  assert.equal(result.relevance, 'relevant');
});
