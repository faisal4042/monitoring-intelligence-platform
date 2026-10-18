import pino from 'pino';
import { config } from '@mip/config';

/**
 * Anything matching these paths is replaced with [REDACTED] before it is
 * written. Secrets must never reach a log file (docs/PROJECT_PLAN.md §64).
 */
const REDACT_PATHS = [
  'password', '*.password',
  'token', '*.token', '*.accessToken', '*.refreshToken',
  'apiKey', '*.apiKey', '*.api_key',
  'bearerToken', '*.bearerToken', 'X_BEARER_TOKEN',
  'authorization', '*.authorization',
  'req.headers.authorization', 'req.headers.cookie',
  'passwordHash', '*.passwordHash',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

/** Named child loggers so the Developer Console can filter by subsystem. */
export const xApiLogger  = logger.child({ subsystem: 'x_api' });
export const budgetLogger = logger.child({ subsystem: 'budget' });
export const aiLogger     = logger.child({ subsystem: 'ai' });
export const alertLogger  = logger.child({ subsystem: 'alerts' });
export const newsLogger   = logger.child({ subsystem: 'news' });

export type Logger = typeof logger;
