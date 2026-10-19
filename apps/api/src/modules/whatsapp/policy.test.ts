/** Unit tests for the WhatsApp channel's pure rules. Run: pnpm --filter @mip/api test (tsx --test). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { maskPhone, normalizeE164, WHATSAPP_EVENTS, ALL_WHATSAPP_PERMISSIONS, ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@mip/shared';
import { backoffSeconds, buildParams, canTransition, cleanParam, idempotencyKey, isOptOutText, placeholderCount, renderPreview, riyadhStamp, verifyMetaSignature } from './policy.js';
import { classifyMetaError, classifyNetworkError, isRetryable } from './errors.js';

test('E.164: accepts international numbers, Arabic digits, 00 prefix; rejects missing country code', () => {
  assert.equal(normalizeE164('+966 50 123 4567'), '+966501234567');
  assert.equal(normalizeE164('00966501234567'), '+966501234567');
  assert.equal(normalizeE164('+٩٦٦٥٠١٢٣٤٥٦٧'), '+966501234567');
  assert.equal(normalizeE164('0501234567'), null, 'local format without country code is refused (never guessed)');
  assert.equal(normalizeE164('+0123456789'), null, 'country code cannot start with 0');
  assert.equal(normalizeE164('+1234567890123456'), null, 'more than 15 digits');
  assert.equal(normalizeE164('+9665abc'), null);
});

test('phone masking never shows more than country code and last four', () => {
  const masked = maskPhone('+966501234567');
  assert.ok(masked.endsWith('4567'));
  assert.ok(!masked.includes('50123'));
  assert.equal(maskPhone(null, '4567'), '••••4567');
});

test('webhook signature: valid HMAC passes, tampered body / wrong secret / bad header fail', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
  const secret = 'test-app-secret-0123456789';
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, sig, secret), true);
  assert.equal(verifyMetaSignature(Buffer.from(body.toString() + ' '), sig, secret), false, 'tampered body');
  assert.equal(verifyMetaSignature(body, sig, 'another-secret-0123456789'), false, 'wrong secret');
  assert.equal(verifyMetaSignature(body, undefined, secret), false, 'missing header');
  assert.equal(verifyMetaSignature(body, 'sha1=abc', secret), false, 'wrong algorithm');
  assert.equal(verifyMetaSignature(body, sig, ''), false, 'no secret configured');
});

test('backoff grows exponentially, is capped, never below base', () => {
  const max = () => 1; // worst-case jitter
  assert.equal(backoffSeconds(1, 30, 1800, max), 30);
  assert.equal(backoffSeconds(2, 30, 1800, max), 60);
  assert.equal(backoffSeconds(3, 30, 1800, max), 120);
  assert.equal(backoffSeconds(10, 30, 1800, max), 1800);
  assert.ok(backoffSeconds(3, 30, 1800, () => 0) >= 30);
});

test('status transitions only move forward; failed and cancelled are final', () => {
  assert.equal(canTransition('accepted', 'sent'), true);
  assert.equal(canTransition('sent', 'delivered'), true);
  assert.equal(canTransition('delivered', 'read'), true);
  assert.equal(canTransition('delivered', 'sent'), false, 'a late «sent» never overwrites «delivered»');
  assert.equal(canTransition('read', 'delivered'), false);
  assert.equal(canTransition('accepted', 'failed'), true);
  assert.equal(canTransition('sent', 'failed'), true);
  assert.equal(canTransition('delivered', 'failed'), false);
  assert.equal(canTransition('failed', 'delivered'), false);
  assert.equal(canTransition('cancelled', 'sent'), false);
  assert.equal(canTransition('sent', 'sent'), false, 'repeat is a no-op');
});

test('template params are scrubbed of personal data and Meta-invalid whitespace', () => {
  assert.equal(cleanParam('تواصل مع @someone على 0501234567 أو a.b@example.com'), 'تواصل مع على أو', 'handle, number and email removed entirely');
  assert.equal(cleanParam('سطر\nثاني\tثالث     رابع'), 'سطر ثاني ثالث رابع');
  assert.equal(cleanParam(''), '—', 'never empty (Meta rejects empty parameters)');
  assert.equal(cleanParam(null), '—');
  assert.ok(cleanParam('x'.repeat(500)).length <= 120);
  assert.equal(cleanParam('MIP-2026-000123'), 'MIP-2026-000123', 'ticket numbers survive');
  assert.equal(cleanParam('انظر https://evil.example/x'), 'انظر', 'links removed unless allowed');
  assert.equal(cleanParam('https://radar.example/queue?item=1', { allowUrl: true, max: 300 }), 'https://radar.example/queue?item=1');
});

test('params follow the template variable order; preview fills placeholders', () => {
  const params = buildParams(['program', 'priority', 'details_url'], { program: 'إيجار', priority: 'مرتفعة', details_url: 'https://radar.example/q' });
  assert.deepEqual(params, ['إيجار', 'مرتفعة', 'https://radar.example/q']);
  assert.equal(renderPreview('البرنامج: {{1}} — الأولوية: {{2}} — {{3}}', params), 'البرنامج: إيجار — الأولوية: مرتفعة — https://radar.example/q');
  assert.equal(placeholderCount('a {{1}} b {{3}} c {{2}}'), 3);
  assert.equal(placeholderCount('بدون متغيرات'), 0);
});

test('opt-out words (Arabic and English) and nothing else', () => {
  for (const w of ['STOP', ' stop ', 'إيقاف', 'الغاء الاشتراك']) assert.equal(isOptOutText(w), true, w);
  for (const w of ['', 'stop please', 'شكرا', undefined]) assert.equal(isOptOutText(w as string), false, String(w));
});

test('idempotency key is stable per (event, recipient)', () => {
  assert.equal(idempotencyKey('qe:1:interaction_assigned', 'r1'), idempotencyKey('qe:1:interaction_assigned', 'r1'));
  assert.notEqual(idempotencyKey('qe:1:interaction_assigned', 'r1'), idempotencyKey('qe:1:interaction_assigned', 'r2'));
});

test('Meta error classification: rate limits retry, config/policy/permanent do not', () => {
  assert.equal(classifyMetaError(400, { error: { code: 130429 } }).class, 'rate_limited');
  assert.equal(classifyMetaError(400, { error: { code: 131056 } }).class, 'rate_limited');
  assert.equal(classifyMetaError(401, { error: { code: 190 } }).class, 'config');
  assert.equal(classifyMetaError(400, { error: { code: 132001 } }).class, 'config');
  assert.equal(classifyMetaError(400, { error: { code: 131050 } }).class, 'policy');
  assert.equal(classifyMetaError(400, { error: { code: 131026 } }).class, 'permanent');
  assert.equal(classifyMetaError(500, { error: { code: 131000 } }).class, 'transient');
  assert.equal(classifyMetaError(503, null).class, 'transient');
  assert.equal(classifyMetaError(429, null, '42').retryAfterSeconds, 42);
  assert.equal(classifyMetaError(418, null).class, 'permanent');
  assert.equal(isRetryable('transient'), true);
  assert.equal(isRetryable('uncertain'), false, 'an uncertain send is never retried automatically');
});

test('network errors: provably unsent → transient; possibly sent → uncertain', () => {
  assert.equal(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).class, 'transient');
  assert.equal(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).class, 'transient');
  assert.equal(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).class, 'uncertain');
  assert.equal(classifyNetworkError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).class, 'uncertain');
});

test('least privilege: no role holds a WhatsApp permission by default', () => {
  for (const p of ALL_WHATSAPP_PERMISSIONS) {
    assert.ok(!(ALL_PERMISSIONS as string[]).includes(p), `${p} must stay out of ALL_PERMISSIONS (admin)`);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) assert.ok(!(perms as string[]).includes(p), `${role} must not hold ${p}`);
  }
});

test('event catalogue is consistent', () => {
  const keys = WHATSAPP_EVENTS.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'unique keys');
  for (const e of WHATSAPP_EVENTS) assert.match(e.key, /^[a-z_]{3,60}$/);
  assert.equal(WHATSAPP_EVENTS.filter((e) => e.group === 'monitoring').length, 8);
  assert.equal(WHATSAPP_EVENTS.filter((e) => e.group === 'queue').length, 8);
  assert.equal(WHATSAPP_EVENTS.filter((e) => e.group === 'operations').length, 6);
});

test('Riyadh timestamp formatting', () => {
  assert.equal(riyadhStamp(new Date('2026-10-19T11:05:00Z')), '2026-10-19 14:05');
});
