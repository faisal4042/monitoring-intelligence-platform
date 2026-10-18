import type { FastifyRequest } from 'fastify';
import { canReadInfluencerCards, canExportInfluencerCards, canReadCardTemplates, canManageCardTemplates } from '@mip/shared';
import { forbidden, unauthorized } from '../../lib/errors.js';

/** Additional card-only role ceiling; existing requirePermission hooks remain authoritative. */
export const requireCardAccess = (action: 'read' | 'export' | 'studio-read' | 'manage' | 'asset') => async (req: FastifyRequest) => {
  if (!req.user) throw unauthorized();
  const allowed = action === 'read' ? canReadInfluencerCards(req.user)
    : action === 'export' ? canExportInfluencerCards(req.user, process.env.CARD_EXPORT_PERMISSION === 'enforce')
    : action === 'manage' ? canManageCardTemplates(req.user)
    : action === 'asset' ? canReadCardTemplates(req.user) || canReadInfluencerCards(req.user) : canReadCardTemplates(req.user);
  if (!allowed) throw forbidden();
};
