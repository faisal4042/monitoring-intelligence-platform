import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { resolve } from 'node:path';

// Load .env from the repo root regardless of which app is starting.
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TZ: z.string().default('Asia/Riyadh'),
  API_PORT: z.coerce.number().int().default(3001),
  APP_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6380'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

  // Safety flags — defaults are deliberately the safe values.
  LIVE_X_API: bool.default('false'),
  X_DRY_RUN: bool.default('false'),
  X_API_KEY: z.string().optional(),
  X_API_SECRET: z.string().optional(),
  X_BEARER_TOKEN: z.string().optional(),
  AUTO_COLLECTION_ENABLED: bool.default('false'),
  AUTO_COLLECTION_TICK_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  AUTO_COLLECTION_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  AUTO_COLLECTION_MAX_RESULTS: z.coerce.number().int().min(10).max(100).default(10),
  AUTO_COLLECTION_MAX_BACKOFF_MINUTES: z.coerce.number().int().min(5).max(1440).default(240),
  AUTO_COLLECTION_EXCLUDED_USERS: z.string().default(''),

  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  AI_API_KEY: z.string().optional(),
  ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI: bool.default('false'),
  EMBEDDING_MODEL: z.string().default('Qwen/Qwen3-Embedding-8B'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().default(1024),
  // High-precision defaults: abstain rather than force a weak topic match.
  // These values still need ongoing calibration against human-reviewed data.
  STAGE2_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.84),
  STAGE2_MIN_MARGIN: z.coerce.number().min(0).max(1).default(0.05),
  // Gates auto-publishing when the LLM names an existing topic itself (it saw
  // the full post text and the whole taxonomy, not just the nearest two cold
  // centroids). This is corroboration against hallucination, not a second
  // "is this really a match" test — reusing STAGE2's blind-cosine bar here
  // rejected verified-correct picks (measured ~0.73 similarity against a
  // cold name+description centroid) while different topics in the same
  // program average ~0.43 similarity to each other, so 0.6 sits well clear
  // of that noise floor without re-imposing the blind-match bar.
  STAGE3_EXISTING_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),
  TOPIC_SUGGESTION_SIMILARITY: z.coerce.number().min(0).max(1).default(0.82),
  TOPIC_SUGGESTION_MIN_SUPPORT: z.coerce.number().int().min(2).max(20).default(3),

  AUTO_CLASSIFICATION_ENABLED: bool.default('false'),
  AUTO_CLASSIFICATION_TICK_SECONDS: z.coerce.number().int().min(10).max(600).default(20),
  AUTO_CLASSIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  SIGNAL_CLUSTER_THRESHOLD: z.coerce.number().min(0.5).max(0.99).default(0.70),
  SIGNAL_MIN_FAMILIES: z.coerce.number().int().min(1).max(20).default(2),
  SIGNAL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(30).default(7),

  // News & Web Monitoring — Phase 1 knobs Test Connection relies on (its own
  // outbound fetch of an admin-supplied URL).
  NEWS_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  NEWS_MAX_RESPONSE_BYTES: z.coerce.number().int().min(10_000).max(20_000_000).default(2_000_000),
  // Phase 2 — the real per-source polling worker. Mirrors AUTO_COLLECTION_*'s
  // naming and defaults-off pattern (opt-in via ENABLED, same as X collection
  // and classification were before they went live).
  NEWS_FETCH_ENABLED: bool.default('false'),
  NEWS_FETCH_TICK_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  NEWS_FETCH_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(5),
  NEWS_FETCH_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  NEWS_FETCH_MAX_BACKOFF_MINUTES: z.coerce.number().int().min(5).max(1440).default(240),
  NEWS_DOMAIN_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1000), // per-domain pacing, not a global rate cap

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n[config] Invalid environment:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the required values.\n');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

// Fail loudly rather than silently running unprotected.
if (config.LIVE_X_API && !config.X_BEARER_TOKEN) {
  console.error(
    '\n[config] LIVE_X_API=true but X_BEARER_TOKEN is empty.\n' +
      'Refusing to start: live collection without credentials would fail on every request.\n',
  );
  process.exit(1);
}

export const isDemoMode = !config.LIVE_X_API;
export const isDryRun = config.LIVE_X_API && config.X_DRY_RUN;

/** live | dry_run | demo — recorded on every api_usage row. */
export const collectionMode: 'live' | 'dry_run' | 'demo' = isDemoMode
  ? 'demo'
  : isDryRun
    ? 'dry_run'
    : 'live';
