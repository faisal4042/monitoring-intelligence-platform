import { PERMISSIONS } from './permissions.js';
import { CARD_PERMISSIONS } from './influencer-card-template.js';

export interface CardActor { role: string; permissions: readonly string[] }
const readers = new Set(['admin', 'supervisor', 'analyst', 'agent']);
const has = (actor: CardActor, permission: string) => actor.permissions.includes(permission);

/** Feature-specific limits; never modifies platform role grants or grants unknown roles access. */
export function canReadInfluencerCards(actor: CardActor | null | undefined): boolean {
  return !!actor && readers.has(actor.role) && has(actor, PERMISSIONS.INFLUENCERS_READ) && has(actor, PERMISSIONS.POSTS_READ);
}
export function canExportInfluencerCards(actor: CardActor | null | undefined, enforce = false): boolean {
  return canReadInfluencerCards(actor) && (!enforce || has(actor!, CARD_PERMISSIONS.EXPORT));
}
export function canReadCardTemplates(actor: CardActor | null | undefined): boolean {
  return !!actor && readers.has(actor.role) &&
    (has(actor, CARD_PERMISSIONS.TEMPLATES_READ) || has(actor, CARD_PERMISSIONS.TEMPLATES_MANAGE));
}
export function canManageCardTemplates(actor: CardActor | null | undefined): boolean {
  return !!actor && ['admin', 'supervisor'].includes(actor.role) && has(actor, CARD_PERMISSIONS.TEMPLATES_MANAGE);
}
