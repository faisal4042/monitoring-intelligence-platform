import { collectionMode, config } from '@mip/config';
import { xApiLogger as log } from '@mip/logger';
import { xApiGateway, type FilteredStreamEvent } from '@mip/x-collector';
import {
  collectStreamPost,
  listFilteredStreamQueries,
  type FilteredStreamQuery,
} from '../modules/collection.service.js';

const TAG_PREFIX = 'mip:';

interface XStreamRuntimeStatus {
  state: 'disabled' | 'starting' | 'syncing_rules' | 'connecting' | 'connected' | 'disconnected';
  rules: number;
  connectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

const runtimeStatus: XStreamRuntimeStatus = {
  state: 'disabled', rules: 0, connectedAt: null, lastEventAt: null, lastError: null,
};

export function getXStreamStatus(): XStreamRuntimeStatus {
  return { ...runtimeStatus };
}

function signature(queries: FilteredStreamQuery[]): string {
  return queries.map((query) => `${query.queryId}:${query.queryVersionId}:${query.value}`).join('\n');
}

function queryIdFromTag(tag?: string): string | null {
  if (!tag?.startsWith(TAG_PREFIX)) return null;
  return tag.slice(TAG_PREFIX.length).split(':', 1)[0] || null;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function startXStreamWorker(): () => void {
  if (!config.X_STREAM_ENABLED || collectionMode !== 'live') {
    log.info({ enabled: config.X_STREAM_ENABLED, mode: collectionMode }, 'X filtered stream is disabled');
    return () => {};
  }

  runtimeStatus.state = 'starting';

  const shutdown = new AbortController();
  let connection: AbortController | null = null;

  void (async () => {
    let backoffSeconds = 1;
    while (!shutdown.signal.aborted) {
      try {
        const queries = await listFilteredStreamQueries();
        runtimeStatus.rules = queries.length;
        const initialSignature = signature(queries);
        if (queries.length === 0) {
          log.warn('X filtered stream has no active query rules; waiting');
          await delay(config.X_STREAM_RULE_REFRESH_SECONDS * 1000, shutdown.signal);
          continue;
        }

        const byId = new Map(queries.map((query) => [query.queryId, query]));
        runtimeStatus.state = 'syncing_rules';
        await xApiGateway.replaceFilteredStreamRules(
          queries.map((query) => ({
            value: query.value,
            tag: `${TAG_PREFIX}${query.queryId}:${query.queryVersionId}`,
          })),
          TAG_PREFIX,
        );

        connection = new AbortController();
        runtimeStatus.state = 'connecting';
        const abortConnection = () => connection?.abort();
        shutdown.signal.addEventListener('abort', abortConnection, { once: true });

        const refreshTimer = setInterval(() => {
          void listFilteredStreamQueries()
            .then((latest) => {
              if (signature(latest) !== initialSignature) connection?.abort();
            })
            .catch((error) => log.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not refresh X stream rules'));
        }, config.X_STREAM_RULE_REFRESH_SECONDS * 1000);
        refreshTimer.unref();

        log.info({ rules: queries.length }, 'X filtered stream connected');
        backoffSeconds = 1;
        try {
          await xApiGateway.streamFiltered(async (event: FilteredStreamEvent) => {
            runtimeStatus.lastEventAt = new Date().toISOString();
            const matchedIds = [...new Set(event.matchingRules.map((rule) => queryIdFromTag(rule.tag)).filter((id): id is string => Boolean(id)))];
            const target = matchedIds.map((id) => byId.get(id)).find(Boolean);
            if (!target) return;
            if (!(await xApiGateway.streamDeliveryAllowed(target.queryId, target.programId))) return;

            await xApiGateway.recordStreamDelivery({
              queryId: target.queryId,
              queryVersionId: target.queryVersionId,
              programId: target.programId,
            });
            const result = await collectStreamPost(target.queryId, event.post);
            log.info({
              queryId: target.queryId, postId: event.post.id,
              inserted: result.inserted, filtered: result.filtered,
            }, 'X filtered-stream post processed');
          }, connection.signal, () => {
            runtimeStatus.state = 'connected';
            runtimeStatus.connectedAt = new Date().toISOString();
            runtimeStatus.lastError = null;
          });
        } finally {
          clearInterval(refreshTimer);
          shutdown.signal.removeEventListener('abort', abortConnection);
          connection = null;
        }
      } catch (error) {
        if (shutdown.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        if ((error as { name?: string }).name !== 'AbortError') {
          runtimeStatus.state = 'disconnected';
          runtimeStatus.lastError = message.slice(0, 500);
          log.error({ err: message, retryInSeconds: backoffSeconds }, 'X filtered stream disconnected');
        }
      }

      if (!shutdown.signal.aborted) {
        await delay(backoffSeconds * 1000, shutdown.signal);
        backoffSeconds = Math.min(backoffSeconds * 2, config.X_STREAM_RECONNECT_MAX_SECONDS);
      }
    }
  })();

  return () => {
    runtimeStatus.state = 'disabled';
    shutdown.abort();
    connection?.abort();
  };
}
