import {workerCheckpoint} from '../startup/worker-ownership.js';
import {trackedTask} from './tracked-task.js';
import {managedLoop, type WorkerStop} from './managed-loop.js';
/**
 * WhatsApp channel tick: housekeeping → detect events → queue messages → send what is due.
 * Independent of the alerts worker (Telegram/email): a WhatsApp failure is logged here and
 * never reaches the other channels. Off unless WHATSAPP_ENABLED=true; idle while migration
 * 0055 is absent or the channel is disabled in its settings.
 */
import { config } from '@mip/config';
import { alertLogger as log } from '@mip/logger';
import { detectEvents } from '../modules/whatsapp/detect.js';
import { enqueueEvent, housekeeping, sendDue } from '../modules/whatsapp/dispatch.js';
import { loadSettings, recordIntegrationError, whatsappSchemaReady } from '../modules/whatsapp/settings.js';

let ticking = false;

/** One pass. Exported for tests (driven with a mock Graph client). */
export async function whatsappTick(opts: Parameters<typeof sendDue>[1] = {}) {
  if (!(await whatsappSchemaReady())) return { skipped: 'not_installed' as const };
  const s = await loadSettings();
  const kept = await housekeeping();
  if (!s.enabled) return { skipped: 'disabled' as const, housekeeping: kept };
  let queued = 0; let withoutTemplate = 0;
  const events = await detectEvents(s, (source, err) => log.error({ source, err: err instanceof Error ? err.message : String(err) }, 'whatsapp detection source failed'));
  for (const e of events) {
    const r = await enqueueEvent(e, s);
    queued += r.queued;
    if (r.skipped) withoutTemplate++;
  }
  if (withoutTemplate) await recordIntegrationError('template_not_approved', `${withoutTemplate} تنبيه بلا قالب معتمد من Meta فلم يُرسل`);
  const sent = await sendDue(s, opts);
  return { events: events.length, queued, sent, housekeeping: kept };
}

function tick() { return trackedTask('whatsapp', runTick); }
async function runTick() {
  await workerCheckpoint();
  if (ticking) return;
  ticking = true;
  try {
    const result = await whatsappTick();
    if ('events' in result && result.sent && (result.events || result.sent.sent || result.sent.failed)) log.info(result, 'whatsapp tick');
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'whatsapp tick failed');
  } finally {
    ticking = false;
  }
}

export function startWhatsAppWorker(options: { transitional?: boolean } = {}): WorkerStop {
  if (!config.WHATSAPP_ENABLED) {
    log.info('whatsapp notifications are disabled (WHATSAPP_ENABLED=false)');
    return async () => {};
  }
  return managedLoop('whatsapp', tick, (error) => log.error({ err: error }, 'whatsapp loop failed'), config.WHATSAPP_TICK_SECONDS * 1000, !options.transitional).stop;
}
