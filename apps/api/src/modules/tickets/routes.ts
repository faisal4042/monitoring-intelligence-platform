/**
 * Ticket API (/api/v1/tickets). Every route checks tickets:* permissions on the server and answers
 * 503 TICKETS_NOT_ACTIVATED while migration 0047 is absent (it is not applied to mip without approval).
 * Visibility is enforced in SQL (service.scope); a ticket outside scope is a 404, never a 403 (no IDOR oracle).
 */
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {PERMISSIONS as P} from '@mip/shared';
import {audit} from '../../lib/audit.js';
import {HttpError} from '../../lib/errors.js';
import {parse, idParams} from '../queue/validation.js';
import {dateBoundsFromQuery} from '../../lib/date-range.js';
import {TICKET_ACTION_LABELS, TICKET_STATUSES, TICKET_STATUS_LABELS, TICKET_ACTIONS, type Actor} from './state-machine.js';
import {CHANNELS, CHANNEL_POLICY} from './conversation-identity.js';
import {getTicket, listTickets, ticketForPost, ticketsActivated, transition, TicketError} from './service.js';

export const actorOf = (req: FastifyRequest): Actor => ({id: req.user.id, perms: new Set(req.user.permissions)});
const READ = [P.TICKETS_READ, P.TICKETS_READ_ALL];

async function guard() {
  if (!(await ticketsActivated())) throw new HttpError(503, 'نظام التذاكر غير مفعّل على قاعدة البيانات هذه بعد (يتطلب اعتماد الترحيل 0047).', 'TICKETS_NOT_ACTIVATED');
}
const wrap = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (error) {
    if (error instanceof TicketError) throw new HttpError(error.status, error.message, error.code);
    throw error;
  }
};

export default async function ticketRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.get('/meta', {preHandler: [app.requirePermission(...READ, P.REPORTS_READ)]}, async () => ({
    activated: await ticketsActivated(),
    statuses: TICKET_STATUSES.map((s) => ({key: s, label: TICKET_STATUS_LABELS[s]})),
    actions: Object.keys(TICKET_ACTIONS).map((a) => ({key: a, label: TICKET_ACTION_LABELS[a as keyof typeof TICKET_ACTION_LABELS]})),
    channels: CHANNELS.map((c) => ({key: c, anchor: CHANNEL_POLICY[c].anchor})),
  }));

  app.get('/', {preHandler: [app.requirePermission(...READ)]}, async (req) => {
    await guard();
    const q = parse(z.object({
      status: z.string().max(200).optional(), programId: z.string().uuid().optional(), assignee: z.string().max(60).optional(),
      channel: z.string().max(300).optional(), review: z.enum(['1', 'true']).optional(), q: z.string().max(40).optional(),
      range: z.string().max(20).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(),
      cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict(), req.query);
    // Optional read-only window on last_activity_at; absent params keep the full history (preset 'all').
    const dates = q.range || q.from || q.to ? dateBoundsFromQuery({range: q.range, from: q.from, to: q.to}) : undefined;
    const status = q.status?.split(',').filter((s) => (TICKET_STATUSES as readonly string[]).includes(s));
    // One channel or a source group (e.g. x_mention,x_reply); unknown names are ignored.
    const channels = q.channel?.split(',').filter((c) => (CHANNELS as readonly string[]).includes(c));
    if (q.assignee && !['me', 'unassigned'].includes(q.assignee)) parse(z.string().uuid(), q.assignee);
    return wrap(() => listTickets(actorOf(req), {...q, status, channels, review: !!q.review, dates: dates ? {from: dates.from, to: dates.to} : undefined}));
  });

  app.get('/by-post/:id', {preHandler: [app.requirePermission(...READ)]}, async (req) => {
    if (!(await ticketsActivated())) return {activated: false, ticket: null};
    const {id} = parse(idParams, req.params);
    return {activated: true, ticket: await ticketForPost(actorOf(req), id)};
  });

  app.get('/:id', {preHandler: [app.requirePermission(...READ)]}, async (req) => {
    await guard();
    const {id} = parse(idParams, req.params);
    return wrap(() => getTicket(actorOf(req), id));
  });

  app.post('/:id/actions/:action', {preHandler: [app.requirePermission(P.TICKETS_WORK, P.TICKETS_ASSIGN, P.TICKETS_MANAGE)]}, async (req) => {
    await guard();
    const {id, action} = parse(z.object({id: z.string().uuid(), action: z.string().max(40)}).strict(), req.params);
    const body = parse(z.object({
      expectedVersion: z.number().int().positive(), reason: z.string().max(2000).optional(), assigneeId: z.string().uuid().nullable().optional(),
      body: z.string().max(20000).optional(), priority: z.enum(['normal', 'high']).optional(),
    }).strict(), req.body);
    const result = await wrap(() => transition(actorOf(req), id, action, {...body, correlationId: req.id}));
    await audit(req, {action: `ticket.${action}`, entityType: 'ticket', entityId: result.id, entityLabel: result.ticketNumber,
      oldValue: {status: result.from}, newValue: {status: result.to, version: result.version, ...(body.assigneeId ? {assigneeId: body.assigneeId} : {})},
      reason: body.reason, severity: action === 'admin_correction' ? 'warning' : 'info'});
    return result;
  });
}
