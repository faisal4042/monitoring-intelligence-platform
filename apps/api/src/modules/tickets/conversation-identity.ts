/**
 * Conversation identity policy (docs/ticket-engine/conversation-identity.md).
 * A key is built only from provider-issued identifiers. Display names, handles and text are never used:
 * two messages share a conversation only when the provider says they share a thread.
 * When no reliable thread id exists, each message becomes its own conversation (`fallback_message`) and the
 * ticket is flagged for human review — the engine never guesses a merge.
 */
export const CHANNELS = ['x_mention', 'x_reply', 'x_dm', 'x_story', 'facebook_comment', 'facebook_inbox', 'telegram', 'youtube_comment', 'youtube_video', 'news_article', 'email', 'other'] as const;
export type Channel = (typeof CHANNELS)[number];
export type IdentityConfidence = 'provider_thread' | 'provider_root' | 'fallback_message';
export const KEY_VERSION = 1;
const TENANT = 'mip';

export interface ConversationInput {
  channel: Channel;
  provider: string;
  managedAccount: string | null;     // our profile/page/bot/mailbox that received the message
  customerId: string;                // provider customer id (never a display name)
  providerThreadId?: string | null;  // DM conversation id, inbox thread id, Telegram chat id, email thread root
  providerRootId?: string | null;    // X conversation_id (root post), Facebook/YouTube root post or video
  providerMessageId: string;
}
const clean = (v: string | null | undefined) => (v ?? '').trim();
const part = (v: string) => encodeURIComponent(v);

/**
 * Which identifier each channel trusts. `family` (optional) is the channel name used INSIDE the key, so channels that
 * describe the same public conversation share it: an X customer's own post (x_mention = public post captured by
 * monitoring, as Konnect's "Twitter Mentions") and that customer's replies in the same thread (x_reply) must land in
 * one conversation, while the stored channel keeps the precise type.
 */
export const CHANNEL_POLICY: Record<Channel, { anchor: 'thread' | 'root' | 'none'; includesCustomer: boolean; family?: string; note: string }> = {
  x_dm:             { anchor: 'thread', includesCustomer: false, note: 'dm_conversation_id from the X DM API; one per participant pair' },
  x_mention:        { anchor: 'root',   includesCustomer: true,  family: 'x_public', note: 'public X post: conversation_id (root post id), scoped per customer so a busy thread does not merge customers' },
  x_reply:          { anchor: 'root',   includesCustomer: true,  family: 'x_public', note: 'reply in a public X thread: same key family and rule as x_mention' },
  facebook_inbox:   { anchor: 'thread', includesCustomer: false, note: 'Messenger thread id of the page conversation' },
  facebook_comment: { anchor: 'root',   includesCustomer: true,  note: 'root post id; per commenter' },
  telegram:         { anchor: 'thread', includesCustomer: false, note: 'chat id with the bot (future)' },
  youtube_comment:  { anchor: 'root',   includesCustomer: true,  note: 'top-level comment thread id; per commenter (author channel id)' },
  youtube_video:    { anchor: 'root',   includesCustomer: true,  note: 'YouTube video id; the customer is the publishing channel' },
  news_article:     { anchor: 'root',   includesCustomer: true,  note: 'news article id; the customer is the news source' },
  x_story:          { anchor: 'root',   includesCustomer: true,  note: 'signal story id: one ticket per approved story card' },
  email:            { anchor: 'thread', includesCustomer: false, note: 'thread root from References / Message-ID (future)' },
  other:            { anchor: 'none',   includesCustomer: true,  note: 'no trusted thread id: fallback per message' },
};

export function conversationKey(input: ConversationInput): { key: string; confidence: IdentityConfidence; threadId: string | null } {
  const policy = CHANNEL_POLICY[input.channel];
  const account = clean(input.managedAccount) || '-';
  const customer = clean(input.customerId);
  if (!customer) throw new Error('customerId is required for every conversation');
  const anchor = policy.anchor === 'thread' ? clean(input.providerThreadId) : policy.anchor === 'root' ? clean(input.providerRootId) : '';
  const head = `v${KEY_VERSION}|${TENANT}|${input.provider}|${policy.family ?? input.channel}|${part(account)}`;
  if (anchor) {
    const key = policy.includesCustomer ? `${head}|c:${part(customer)}|t:${part(anchor)}` : `${head}|t:${part(anchor)}`;
    return { key, confidence: policy.anchor === 'thread' ? 'provider_thread' : 'provider_root', threadId: anchor };
  }
  return { key: `${head}|c:${part(customer)}|fallback:${part(clean(input.providerMessageId))}`, confidence: 'fallback_message', threadId: null };
}
