/**
 * Session and password lifecycle. A user's sessions are their refresh tokens;
 * access tokens are short-lived and additionally voided by
 * users.password_changed_at (checked in plugins/auth.ts).
 */
import crypto from 'node:crypto';
import { sql } from '@mip/db';

/**
 * Revokes every live refresh token of a user, optionally keeping one (the
 * session making the change). Tokens are also expired so the rotation grace
 * window in consumeRefreshToken cannot revive them. Returns how many were
 * revoked.
 */
export async function revokeUserSessions(userId: string, keepTokenHash?: string | null): Promise<number> {
  const rows = await sql`
    UPDATE refresh_tokens
    SET revoked_at = now(), expires_at = LEAST(expires_at, now())
    WHERE user_id = ${userId}::uuid
      AND revoked_at IS NULL AND expires_at > now()
      AND (${keepTokenHash ?? null}::text IS NULL OR token_hash <> ${keepTokenHash ?? null})
    RETURNING id`;
  return rows.length;
}

/**
 * The value stored in users.password_changed_at. Taken from the app's clock —
 * the same clock signAccessToken() reads it back with — at millisecond
 * precision, so tokens from before the change are void and the very next
 * token is not.
 */
export function passwordChangeInstant(): string {
  return new Date().toISOString();
}

export const MIN_PASSWORD_LENGTH = 12;

/** Unambiguous characters only — the password is read off a screen and typed once. */
const ALPHABET = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digit: '23456789',
  symbol: '!@#$%*-_=+?',
};

/**
 * A cryptographically random temporary password: 20 characters with at least
 * one of each class. It is returned to the administrator once and only its
 * argon2 hash is ever stored.
 */
export function generateTemporaryPassword(length = 20): string {
  const all = Object.values(ALPHABET).join('');
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(ALPHABET.upper), pick(ALPHABET.lower), pick(ALPHABET.digit), pick(ALPHABET.symbol)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates with a CSPRNG so the guaranteed classes aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
