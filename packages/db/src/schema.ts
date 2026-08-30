/**
 * Drizzle table definitions used for typed queries.
 * DDL lives in migrations/*.sql — these definitions mirror it.
 */
import {
  pgTable, pgEnum, uuid, text, boolean, integer, smallint, bigint,
  timestamp, numeric, jsonb, customType, primaryKey, index,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// pgvector's own column type isn't in this drizzle-orm version's pg-core —
// mirrored by hand like `bytea`, per the file header note.
const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector(1024)',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => value.slice(1, -1).split(',').map(Number),
});

export const keywordType = pgEnum('keyword_type', ['primary', 'service', 'related', 'negative', 'sensitive']);
export const queryStatus = pgEnum('query_status', ['draft', 'tested', 'approved', 'active', 'paused', 'archived']);
export const pollingTier = pgEnum('polling_tier', ['hot', 'warm', 'cold', 'manual']);
export const postStatus = pgEnum('post_status', ['ingested', 'filtered_out', 'classified', 'duplicate', 'error']);
export const relevanceLabel = pgEnum('relevance_label', ['relevant', 'irrelevant', 'advertisement', 'spam', 'unknown']);
export const intentLabel = pgEnum('intent_label', ['complaint', 'inquiry', 'suggestion', 'praise', 'news', 'experience', 'warning', 'issue', 'request', 'other']);
export const sentimentLabel = pgEnum('sentiment_label', ['very_positive', 'positive', 'neutral', 'negative', 'very_negative']);
export const apiPurpose = pgEnum('api_purpose', ['collection', 'test', 'author_refresh', 'manual', 'backfill']);
export const budgetScope = pgEnum('budget_scope', ['global', 'program', 'query', 'purpose']);
export const budgetPeriod = pgEnum('budget_period', ['hour', 'day', 'month']);

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ─── Identity ────────────────────────────────────────────────────

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  domain: text('domain').notNull(),
  descriptionAr: text('description_ar').notNull(),
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull(),
  permissionKey: text('permission_key').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionKey] }) }));

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  roleId: uuid('role_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  locale: text('locale').notNull().default('ar'),
  theme: text('theme').notNull().default('system'),
  lastLoginAt: ts('last_login_at'),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const userPermissions = pgTable('user_permissions', {
  userId: uuid('user_id').notNull(),
  permissionKey: text('permission_key').notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: ts('granted_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.permissionKey] }) }));

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ─── Programs & Taxonomy ─────────────────────────────────────────

export const programs = pgTable('programs', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  description: text('description'),
  color: text('color'),
  officialAccounts: text('official_accounts').array().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  budgetSharePct: numeric('budget_share_pct'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  deletedAt: ts('deleted_at'),
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').notNull(),
  key: text('key').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en'),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').notNull(),
  serviceId: uuid('service_id'),
  parentId: uuid('parent_id'),
  level: smallint('level').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en'),
  description: text('description'),
  source: text('source').notNull().default('manual'),
  centroid: vector1024('centroid'),
  isActive: boolean('is_active').notNull().default(true),
  postCount: integer('post_count').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const topicKeywords = pgTable('topic_keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicId: uuid('topic_id').notNull(),
  term: text('term').notNull(),
  kind: text('kind').notNull().default('alias'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const topicMergeHistory = pgTable('topic_merge_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceTopicId: uuid('source_topic_id').notNull(),
  targetTopicId: uuid('target_topic_id').notNull(),
  movedPosts: integer('moved_posts').notNull().default(0),
  movedChildren: integer('moved_children').notNull().default(0),
  mergedBy: uuid('merged_by'),
  mergedAt: ts('merged_at').notNull().defaultNow(),
  note: text('note'),
});

export const topicSuggestions = pgTable('topic_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').notNull(),
  serviceId: uuid('service_id'),
  nameAr: text('name_ar').notNull(),
  description: text('description'),
  centroid: vector1024('centroid').notNull(),
  supportCount: integer('support_count').notNull().default(1),
  status: text('status').notNull().default('pending'),
  sourceModel: text('source_model'),
  legacyTopicId: uuid('legacy_topic_id'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  reviewNote: text('review_note'),
  approvedTopicId: uuid('approved_topic_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const topicSuggestionMembers = pgTable('topic_suggestion_members', {
  suggestionId: uuid('suggestion_id').notNull(),
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  similarity: numeric('similarity'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.suggestionId, t.postId, t.postedAt] }) }));

/**
 * Stage 2 embeddings (docs/AI_PIPELINE.md §4/§7.4) — one vector per post,
 * compared against `topics.centroid` with pgvector's `<=>` operator instead
 * of a per-post LLM call.
 */
export const postMedia = pgTable('post_media', {
  mediaKey: text('media_key').notNull(),
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  type: text('type').notNull(),
  url: text('url'),
  previewImageUrl: text('preview_image_url'),
  width: integer('width'),
  height: integer('height'),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.mediaKey, t.postId, t.postedAt] }) }));

export const postEmbeddings = pgTable('post_embeddings', {
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  embedding: vector1024('embedding').notNull(),
  model: text('model').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.postId, t.postedAt] }) }));

// ─── Keywords ────────────────────────────────────────────────────

export const keywordGroups = pgTable('keyword_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id'),
  key: text('key').notNull(),
  nameAr: text('name_ar').notNull(),
  type: keywordType('type').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const keywords = pgTable('keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull(),
  programId: uuid('program_id'),
  serviceId: uuid('service_id'),
  term: text('term').notNull(),
  termNormalized: text('term_normalized').notNull(),
  type: keywordType('type').notNull(),
  matchMode: text('match_mode').notNull().default('term'),
  language: text('language').notNull().default('ar'),
  weight: numeric('weight').notNull().default('1.0'),
  source: text('source').notNull().default('manual'),
  matchCount: integer('match_count').notNull().default(0),
  relevantCount: integer('relevant_count').notNull().default(0),
  irrelevantCount: integer('irrelevant_count').notNull().default(0),
  noiseRate: numeric('noise_rate'),
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (t) => ({ byProgram: index('kw_program_idx').on(t.programId, t.type) }));

export const keywordAliases = pgTable('keyword_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull(),
  alias: text('alias').notNull(),
  aliasNormalized: text('alias_normalized').notNull(),
  aliasType: text('alias_type').notNull(),
  confidence: numeric('confidence'),
  source: text('source').notNull().default('manual'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ─── Queries ─────────────────────────────────────────────────────

export const queries = pgTable('queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').notNull(),
  serviceId: uuid('service_id'),
  name: text('name').notNull(),
  description: text('description'),
  status: queryStatus('status').notNull().default('draft'),
  currentVersionId: uuid('current_version_id'),
  pollingTier: pollingTier('polling_tier').notNull().default('warm'),
  pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(5),
  maxResultsPerCall: integer('max_results_per_call').notNull().default(50),
  maxPagesPerRun: integer('max_pages_per_run').notNull().default(1),
  sinceId: text('since_id'),
  lastRunAt: ts('last_run_at'),
  lastSuccessAt: ts('last_success_at'),
  nextRunAt: ts('next_run_at'),
  totalRequests: bigint('total_requests', { mode: 'number' }).notNull().default(0),
  totalUnits: bigint('total_units', { mode: 'number' }).notNull().default(0),
  totalRelevant: bigint('total_relevant', { mode: 'number' }).notNull().default(0),
  totalIrrelevant: bigint('total_irrelevant', { mode: 'number' }).notNull().default(0),
  precisionRate: numeric('precision_rate'),
  isPaused: boolean('is_paused').notNull().default(false),
  pauseReason: text('pause_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  deletedAt: ts('deleted_at'),
});

export const queryVersions = pgTable('query_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  queryId: uuid('query_id').notNull(),
  version: integer('version').notNull(),
  ast: jsonb('ast').notNull(),
  compiled: text('compiled').notNull(),
  compiledLength: integer('compiled_length').notNull(),
  breadthScore: numeric('breadth_score'),
  noiseRiskScore: numeric('noise_risk_score'),
  estimatedUnitsPerRun: integer('estimated_units_per_run'),
  actualPrecision: numeric('actual_precision'),
  actualUnits: bigint('actual_units', { mode: 'number' }).notNull().default(0),
  changeSummary: text('change_summary'),
  diff: jsonb('diff'),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const queryTests = pgTable('query_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  queryId: uuid('query_id').notNull(),
  queryVersionId: uuid('query_version_id').notNull(),
  sampleSize: integer('sample_size').notNull(),
  postsReturned: integer('posts_returned').notNull().default(0),
  countRelevant: integer('count_relevant').notNull().default(0),
  countIrrelevant: integer('count_irrelevant').notNull().default(0),
  countAdvertisement: integer('count_advertisement').notNull().default(0),
  countSpam: integer('count_spam').notNull().default(0),
  countUnknown: integer('count_unknown').notNull().default(0),
  precisionScore: numeric('precision_score'),
  noiseRate: numeric('noise_rate'),
  unitsConsumed: integer('units_consumed').notNull().default(0),
  costEstimate: numeric('cost_estimate'),
  recommendations: jsonb('recommendations'),
  keywordContribution: jsonb('keyword_contribution'),
  passed: boolean('passed'),
  humanReviewed: boolean('human_reviewed').notNull().default(false),
  status: text('status').notNull().default('running'),
  errorMessage: text('error_message'),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const queryTestPosts = pgTable('query_test_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  testId: uuid('test_id').notNull(),
  xPostId: text('x_post_id').notNull(),
  text: text('text').notNull(),
  authorUsername: text('author_username'),
  aiLabel: text('ai_label').notNull(),
  aiConfidence: numeric('ai_confidence'),
  aiReasonAr: text('ai_reason_ar'),
  humanLabel: text('human_label'),
  matchedTerms: text('matched_terms').array(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ─── Influencers ───────────────────────────────────────────────────

export const trackedInfluencers = pgTable('tracked_influencers', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  xUserId: text('x_user_id'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  addedBy: uuid('added_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ─── Posts & Authors ─────────────────────────────────────────────

export const authors = pgTable('authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  xAuthorId: text('x_author_id').notNull().unique(),
  username: text('username'),
  displayName: text('display_name'),
  description: text('description'),
  profileImageUrl: text('profile_image_url'),
  location: text('location'),
  followersCount: integer('followers_count'),
  followingCount: integer('following_count'),
  tweetCount: integer('tweet_count'),
  listedCount: integer('listed_count'),
  isVerified: boolean('is_verified'),
  verifiedType: text('verified_type'),
  accountCreatedAt: ts('account_created_at'),
  cacheTier: text('cache_tier').notNull().default('normal'),
  profileFetchedAt: ts('profile_fetched_at'),
  nextRefreshAt: ts('next_refresh_at'),
  fetchCount: integer('fetch_count').notNull().default(0),
  fetchFailedCount: integer('fetch_failed_count').notNull().default(0),
  influenceScore: numeric('influence_score'),
  relevantPostCount: integer('relevant_post_count').notNull().default(0),
  totalPostCount: integer('total_post_count').notNull().default(0),
  avgEngagement: numeric('avg_engagement'),
  negativeRatio: numeric('negative_ratio'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at'),
  isFlagged: boolean('is_flagged').notNull().default(false),
  notes: text('notes'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const posts = pgTable('posts', {
  id: uuid('id').notNull().defaultRandom(),
  xPostId: text('x_post_id').notNull(),
  authorId: uuid('author_id'),
  xAuthorId: text('x_author_id').notNull(),
  text: text('text').notNull(),
  textNormalized: text('text_normalized').notNull(),
  lang: text('lang'),
  postedAt: ts('posted_at').notNull(),
  url: text('url'),
  conversationId: text('conversation_id'),
  inReplyToPostId: text('in_reply_to_post_id'),
  referencedPostId: text('referenced_post_id'),
  referenceType: text('reference_type'),
  isReply: boolean('is_reply').notNull().default(false),
  isQuote: boolean('is_quote').notNull().default(false),
  isRepost: boolean('is_repost').notNull().default(false),
  hashtags: text('hashtags').array(),
  mentions: text('mentions').array(),
  urls: text('urls').array(),
  hasMedia: boolean('has_media').notNull().default(false),
  source: text('source').notNull().default('x'),
  queryId: uuid('query_id'),
  queryVersionId: uuid('query_version_id'),
  matchedKeywords: text('matched_keywords').array(),
  matchedKeywordIds: uuid('matched_keyword_ids').array(),
  contentHash: bytea('content_hash').notNull(),
  simhash: bigint('simhash', { mode: 'number' }),
  duplicateOfId: uuid('duplicate_of_id'),
  duplicateType: text('duplicate_type'),
  status: postStatus('status').notNull().default('ingested'),
  filterReason: text('filter_reason'),
  riskScore: smallint('risk_score'),
  riskFactors: jsonb('risk_factors'),
  collectedAt: ts('collected_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  containsPii: boolean('contains_pii').notNull().default(false),
  isRedacted: boolean('is_redacted').notNull().default(false),
  redactedAt: ts('redacted_at'),
}, (t) => ({ pk: primaryKey({ columns: [t.id, t.postedAt] }) }));

export const postClassifications = pgTable('post_classifications', {
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  relevance: relevanceLabel('relevance').notNull(),
  relevanceConfidence: numeric('relevance_confidence'),
  intent: intentLabel('intent'),
  intentConfidence: numeric('intent_confidence'),
  programId: uuid('program_id'),
  serviceId: uuid('service_id'),
  topicId: uuid('topic_id'),
  subtopicId: uuid('subtopic_id'),
  issueId: uuid('issue_id'),
  stage: smallint('stage').notNull(),
  model: text('model'),
  llmTokensIn: integer('llm_tokens_in'),
  llmTokensOut: integer('llm_tokens_out'),
  llmCost: numeric('llm_cost'),
  reasonAr: text('reason_ar'),
  humanCorrected: boolean('human_corrected').notNull().default(false),
  correctedBy: uuid('corrected_by'),
  correctedAt: ts('corrected_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.postId, t.postedAt] }) }));

export const postSentiments = pgTable('post_sentiments', {
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  label: sentimentLabel('label').notNull(),
  score: numeric('score'),
  confidence: numeric('confidence'),
  stage: smallint('stage').notNull(),
  model: text('model'),
  humanCorrected: boolean('human_corrected').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.postId, t.postedAt] }) }));

export const postMetrics = pgTable('post_metrics', {
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  likeCount: integer('like_count').notNull().default(0),
  repostCount: integer('repost_count').notNull().default(0),
  replyCount: integer('reply_count').notNull().default(0),
  quoteCount: integer('quote_count').notNull().default(0),
  bookmarkCount: integer('bookmark_count'),
  impressionCount: integer('impression_count'),
  engagementTotal: integer('engagement_total'),
  velocityPerHour: numeric('velocity_per_hour'),
  capturedAt: ts('captured_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.postId, t.postedAt, t.capturedAt] }) }));

// Dynamic story layer: many posts collapse into one traceable signal. Topics
// remain the stable taxonomy; signal stories represent live conversations.
export const signalStories = pgTable('signal_stories', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').notNull(),
  topicId: uuid('topic_id').notNull(),
  titleAr: text('title_ar').notNull(),
  summaryAr: text('summary_ar'),
  whyAr: text('why_ar').notNull(),
  centroid: vector1024('centroid').notNull(),
  state: text('state').notNull().default('candidate'),
  firstSeenAt: ts('first_seen_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull(),
  postCount: integer('post_count').notNull().default(0),
  familyCount: integer('family_count').notNull().default(0),
  authorCount: integer('author_count').notNull().default(0),
  influencerCount: integer('influencer_count').notNull().default(0),
  engagementTotal: integer('engagement_total').notNull().default(0),
  postsAdded15m: integer('posts_added_15m').notNull().default(0),
  postsAdded1h: integer('posts_added_1h').notNull().default(0),
  liveScore: numeric('live_score').notNull().default('0'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const signalStoryMembers = pgTable('signal_story_members', {
  storyId: uuid('story_id').notNull(),
  postId: uuid('post_id').notNull(),
  postedAt: ts('posted_at').notNull(),
  familyKey: text('family_key').notNull(),
  sourceRole: text('source_role').notNull().default('customer'),
  similarity: numeric('similarity'),
  isRepresentative: boolean('is_representative').notNull().default(false),
  addedAt: ts('added_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.storyId, t.postId, t.postedAt] }) }));

export const signalStorySnapshots = pgTable('signal_story_snapshots', {
  storyId: uuid('story_id').notNull(),
  sampledAt: ts('sampled_at').notNull().defaultNow(),
  postCount: integer('post_count').notNull(),
  familyCount: integer('family_count').notNull(),
  liveScore: numeric('live_score').notNull(),
  state: text('state').notNull(),
  rank: integer('rank'),
}, (t) => ({ pk: primaryKey({ columns: [t.storyId, t.sampledAt] }) }));

// ─── Cost & Budget ───────────────────────────────────────────────

export const apiUsage = pgTable('api_usage', {
  id: uuid('id').notNull().defaultRandom(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  provider: text('provider').notNull().default('x'),
  endpoint: text('endpoint').notNull(),
  purpose: apiPurpose('purpose').notNull(),
  queryId: uuid('query_id'),
  queryVersionId: uuid('query_version_id'),
  programId: uuid('program_id'),
  testId: uuid('test_id'),
  requestsCount: integer('requests_count').notNull().default(1),
  unitsConsumed: integer('units_consumed').notNull().default(0),
  postsNew: integer('posts_new').notNull().default(0),
  postsDuplicate: integer('posts_duplicate').notNull().default(0),
  unitPrice: numeric('unit_price').notNull(),
  costEstimate: numeric('cost_estimate').notNull().default('0'),
  httpStatus: integer('http_status'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  latencyMs: integer('latency_ms'),
  rateLimitRemaining: integer('rate_limit_remaining'),
  mode: text('mode').notNull().default('live'),
  triggeredBy: uuid('triggered_by'),
}, (t) => ({ pk: primaryKey({ columns: [t.id, t.occurredAt] }) }));

export const apiDenials = pgTable('api_denials', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  queryId: uuid('query_id'),
  programId: uuid('program_id'),
  purpose: apiPurpose('purpose').notNull(),
  reason: text('reason').notNull(),
  scope: text('scope'),
  currentUsage: numeric('current_usage'),
  limitValue: numeric('limit_value'),
  requestedUnits: integer('requested_units'),
});

export const apiBudgets = pgTable('api_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: budgetScope('scope').notNull(),
  scopeId: uuid('scope_id'),
  period: budgetPeriod('period').notNull(),
  unitLimit: integer('unit_limit'),
  costLimit: numeric('cost_limit'),
  isHardLimit: boolean('is_hard_limit').notNull().default(true),
  alertThresholds: smallint('alert_thresholds').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  effectiveFrom: ts('effective_from').notNull().defaultNow(),
  effectiveTo: ts('effective_to'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const budgetCounters = pgTable('budget_counters', {
  scope: budgetScope('scope').notNull(),
  scopeId: uuid('scope_id').notNull(),
  period: budgetPeriod('period').notNull(),
  periodStart: ts('period_start').notNull(),
  unitsUsed: integer('units_used').notNull().default(0),
  costUsed: numeric('cost_used').notNull().default('0'),
  requestsUsed: integer('requests_used').notNull().default(0),
  lastThresholdAlerted: smallint('last_threshold_alerted'),
  reconciledAt: ts('reconciled_at'),
}, (t) => ({ pk: primaryKey({ columns: [t.scope, t.scopeId, t.period, t.periodStart] }) }));

export const killSwitches = pgTable('kill_switches', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  targetId: uuid('target_id'),
  isActive: boolean('is_active').notNull().default(true),
  reason: text('reason').notNull(),
  activatedBy: uuid('activated_by').notNull(),
  activatedAt: ts('activated_at').notNull().defaultNow(),
  expiresAt: ts('expires_at'),
  deactivatedBy: uuid('deactivated_by'),
  deactivatedAt: ts('deactivated_at'),
});

export const costRecommendations = pgTable('cost_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  queryId: uuid('query_id'),
  programId: uuid('program_id'),
  titleAr: text('title_ar').notNull(),
  detailAr: text('detail_ar').notNull(),
  evidence: jsonb('evidence').notNull(),
  suggestedAction: jsonb('suggested_action'),
  estimatedSavingUnits: integer('estimated_saving_units'),
  estimatedSavingCost: numeric('estimated_saving_cost'),
  status: text('status').notNull().default('pending'),
  appliedBy: uuid('applied_by'),
  appliedAt: ts('applied_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ─── Feedback, Settings, Audit ───────────────────────────────────

export const aiFeedback = pgTable('ai_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id'),
  postedAt: ts('posted_at'),
  testPostId: uuid('test_post_id'),
  feedbackType: text('feedback_type').notNull(),
  aiValue: text('ai_value').notNull(),
  aiConfidence: numeric('ai_confidence'),
  aiStage: smallint('ai_stage'),
  humanValue: text('human_value').notNull(),
  reason: text('reason'),
  postTextSnapshot: text('post_text_snapshot'),
  embedding: vector1024('embedding'),
  usedInTraining: boolean('used_in_training').notNull().default(false),
  trainingBatchId: uuid('training_batch_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
});

export const keywordFeedback = pgTable('keyword_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id'),
  postedAt: ts('posted_at'),
  queryId: uuid('query_id'),
  matchedKeywordId: uuid('matched_keyword_id'),
  matchedTerm: text('matched_term'),
  action: text('action').notNull(),
  applied: boolean('applied').notNull().default(false),
  resultingKeywordId: uuid('resulting_keyword_id'),
  notes: text('notes'),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  valueType: text('value_type').notNull(),
  category: text('category').notNull(),
  descriptionAr: text('description_ar'),
  isSensitive: boolean('is_sensitive').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  userId: uuid('user_id'),
  userEmail: text('user_email'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  entityLabel: text('entity_label'),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  reason: text('reason'),
  userAgent: text('user_agent'),
  requestId: uuid('request_id'),
  severity: text('severity').notNull().default('info'),
});

export const mentionMetricsHourly = pgTable('mention_metrics_hourly', {
  bucket: ts('bucket').notNull(),
  programId: uuid('program_id').notNull(),
  serviceId: uuid('service_id').notNull(),
  topicId: uuid('topic_id').notNull(),
  totalPosts: integer('total_posts').notNull().default(0),
  relevantPosts: integer('relevant_posts').notNull().default(0),
  irrelevantPosts: integer('irrelevant_posts').notNull().default(0),
  adPosts: integer('ad_posts').notNull().default(0),
  spamPosts: integer('spam_posts').notNull().default(0),
  positiveCount: integer('positive_count').notNull().default(0),
  neutralCount: integer('neutral_count').notNull().default(0),
  negativeCount: integer('negative_count').notNull().default(0),
  complaintCount: integer('complaint_count').notNull().default(0),
  inquiryCount: integer('inquiry_count').notNull().default(0),
  uniqueAuthors: integer('unique_authors').notNull().default(0),
  influencerPosts: integer('influencer_posts').notNull().default(0),
  totalEngagement: bigint('total_engagement', { mode: 'number' }).notNull().default(0),
  maxRiskScore: smallint('max_risk_score'),
  avgRiskScore: numeric('avg_risk_score'),
}, (t) => ({ pk: primaryKey({ columns: [t.bucket, t.programId, t.serviceId, t.topicId] }) }));

// ─── News & Web Monitoring (independent of X monitoring) ──────────
export const newsSources = pgTable('news_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id'),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en'),
  baseUrl: text('base_url').notNull(),
  logoUrl: text('logo_url'),
  country: text('country'),
  language: text('language').notNull().default('ar'),
  sourceType: text('source_type').notNull().default('news_site'),
  connectorType: text('connector_type').notNull().default('auto'),
  rssUrl: text('rss_url'),
  sitemapUrl: text('sitemap_url'),
  apiUrl: text('api_url'),
  sourceWeight: smallint('source_weight').notNull().default(50),
  checkIntervalMinutes: integer('check_interval_minutes').notNull().default(5),
  nextRunAt: ts('next_run_at'),
  lastCheckedAt: ts('last_checked_at'),
  lastSuccessAt: ts('last_success_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  robotsCheckedAt: ts('robots_checked_at'),
  robotsStatus: text('robots_status'),
  crawlAllowed: boolean('crawl_allowed').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const newsSourceHealth = pgTable('news_source_health', {
  sourceId: uuid('source_id').primaryKey(),
  state: text('state').notNull().default('healthy'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastCheckAt: ts('last_check_at'),
  lastSuccessAt: ts('last_success_at'),
  totalFetches: bigint('total_fetches', { mode: 'number' }).notNull().default(0),
  totalErrors: bigint('total_errors', { mode: 'number' }).notNull().default(0),
  avgResponseMs: integer('avg_response_ms'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const newsArticles = pgTable('news_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull(),
  url: text('url').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  urlHash: text('url_hash').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  author: text('author'),
  language: text('language'),
  imageUrl: text('image_url'),
  publisherName: text('publisher_name'),
  publisherUrl: text('publisher_url'),
  publishedAt: ts('published_at'),
  discoveredAt: ts('discovered_at').notNull().defaultNow(),
  rawMetadata: jsonb('raw_metadata'),
  isRelevant: boolean('is_relevant'),
  matchedKeyword: text('matched_keyword'),
  programId: uuid('program_id'),
  topicId: uuid('topic_id'),
  relevanceScore: integer('relevance_score').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const newsFetchJobs = pgTable('news_fetch_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull(),
  status: text('status').notNull(),
  connectorUsed: text('connector_used'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  itemsDiscovered: integer('items_discovered').notNull().default(0),
  itemsNew: integer('items_new').notNull().default(0),
  error: text('error'),
  triggeredBy: text('triggered_by').notNull().default('scheduler'),
});
