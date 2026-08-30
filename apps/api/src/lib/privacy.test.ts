import assert from 'node:assert/strict';
import test from 'node:test';
import { containsSensitiveData, redactSensitiveText } from './privacy.js';

test('detects and masks common Saudi personal identifiers', () => {
  const input = [
    'البريد user@example.com',
    'الجوال 0551234567 أو +966 55 123 4567',
    'الهوية 1234567890',
    'الآيبان SA0380000000608010167519',
  ].join('، ');

  assert.equal(containsSensitiveData(input), true);
  const output = redactSensitiveText(input);
  assert.doesNotMatch(output, /user@example\.com/);
  assert.doesNotMatch(output, /0551234567/);
  assert.doesNotMatch(output, /1234567890/);
  assert.doesNotMatch(output, /SA0380000000608010167519/);
  assert.match(output, /\[بريد محجوب\]/);
  assert.match(output, /\[جوال محجوب\]/);
  assert.match(output, /\[هوية محجوبة\]/);
  assert.match(output, /\[آيبان محجوب\]/);
});

test('keeps ordinary public text and ticket numbers unchanged', () => {
  const input = 'تم تحديث التذكرة 199011 وحالة الخدمة مستقرة';
  assert.equal(containsSensitiveData(input), false);
  assert.equal(redactSensitiveText(input), input);
});

test('redacts URLs only for external AI payloads', () => {
  const input = 'راجع https://example.com/ticket/123';
  assert.equal(redactSensitiveText(input), input);
  assert.equal(redactSensitiveText(input, { redactUrls: true }), 'راجع [رابط محجوب]');
});
