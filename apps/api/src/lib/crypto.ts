/**
 * Encrypts notification-channel config (SMTP passwords, bot tokens) at rest.
 * Key is derived from JWT_SECRET rather than a separate env var — one less
 * required secret to set on every deploy, and JWT_SECRET is already a
 * high-entropy value nothing else exposes.
 */
import crypto from 'node:crypto';
import { config } from '@mip/config';

const key = crypto.createHash('sha256').update(`notify:${config.JWT_SECRET}`).digest();

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptJson<T>(encoded: string): T {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
