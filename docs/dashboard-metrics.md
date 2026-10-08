# Dashboard metrics — definitions

The unified dashboard (`/dashboard`, API `/api/v1/dashboard/*`) shows one view for all programs or one program. Every figure on it is defined here. Code: `apps/api/src/modules/dashboard/`.

## Common rules

| Rule | Detail |
|---|---|
| Time zone | Periods are Asia/Riyadh calendar days (`@mip/shared` date-range). Stored timestamps are UTC; filters are half-open `[from, to)`. |
| Periods | today, yesterday, 7d, 30d, 90d, custom. Default 30d. |
| Previous period | The same length immediately before. A running period is compared up to "now" (today until 14:00 vs yesterday until 14:00). No percentage when the previous value is 0 ("لا توجد فترة أساس"). Unbounded ranges have no comparison. |
| Counted posts | X posts, not redacted, not `duplicate`, by **publication time** (`posts.posted_at`), never collection time. |
| Program of a post | One classification row per post, so a post has at most one program. Program rows therefore never double count; rows + "unlinked" = the all-programs total. |
| Effective classification | If the post's queue item is closed with a review (the review of its current closure), the reviewer's values (program, type, relevance, topic, subtopic, sentiment) are used; otherwise the AI's. The AI rows are never modified. |
| Volume vs content | Total and excluded count every collected post. Types, topics, sentiment and hashtags count **relevant** posts only. |
| Scope | All `/dashboard/*` routes need `posts:read`. Influencers need `influencers:read`, stories `topics:read`, news `news:read`, team performance and AI quality the queue scope (own / team / all, applied in SQL). |
| Cache | 60–120 s in-process, only for figures identical for every `posts:read` holder. Key = section + every result-changing filter + permission flags. Queue and AI figures are never cached. Manual refresh bypasses it. |

## KPIs

| KPI | Definition | Source | Date basis | Count type | Snapshot / period |
|---|---|---|---|---|---|
| إجمالي المنشورات المجمعة | Counted posts in the window | posts | posted_at | events (posts) | period |
| المنشورات ذات الصلة | Effective relevance = relevant | posts + classification/review | posted_at | posts | period |
| المنشورات المستبعدة | Status `filtered_out`, or effective relevance irrelevant / advertisement / spam | same | posted_at | posts | period |
| الاستفسارات / الشكاوى | Relevant posts whose effective type is inquiry / complaint | same | posted_at | posts | period |
| المؤثرون النشطون | Distinct active tracked accounts with ≥1 counted post (matched to authors by username) | tracked_influencers + posts | posted_at | unique accounts | period |
| القصص المعتمدة | Approved stories (`state <> 'candidate'`, ≥2 independent source families) with activity (last_seen) in the window | signal_stories | last_seen_at | unique stories | period |
| الهاشتاقات الفريدة | Distinct normalised hashtags in relevant posts | posts.hashtags / text | posted_at | unique tags | period |

Posts not yet classified are reported separately ("لم تُصنف بعد"), never as neutral or irrelevant.

## Sections

**Trend** — per bucket (hour ≤ 2 days, day ≤ 120 days, Sunday-based week otherwise, Riyadh time): all posts, relevant, complaints, inquiries. The previous window is bucketed the same way and aligned by position. Buckets stop at the database clock.

**Programs** — per program: posts, relevant, complaints, inquiries, negative share (negative ÷ sentiment-classified relevant posts), active influencers, approved stories with activity. In the program view this section shows the program's top main topics.

**Classifications** — types and main/sub topics over relevant posts, current vs previous. Topics come from the `topics` table (main = level 1, sub = level 2; an AI link to a subtopic counts under its parent as main topic). Growth list requires ≥3 posts.

**Sentiment** — positive (very_positive + positive), neutral, negative (negative + very_negative), unclassified. Shares are over sentiment-classified posts only; unclassified is shown apart; sample size shown. The negative-share trend skips buckets with fewer than 5 classified posts. X posts only (news sentiment is not mixed in).

**Hashtags** — from X's extracted `posts.hashtags`, or the text when X gave none and it contains `#`. Each tag counts once per post. Key normalisation: NFKC, lower case, Arabic diacritics/tatweel removed, alef/ya/ta-marbuta/hamza forms and Arabic-Indic digits unified (same rules as `normalizeArabic`); the most common original spelling is displayed. Query keywords are never treated as hashtags. "New" = not used in the previous equal window. Usages = posts × tags.

**Influencers** — tracked (active list, snapshot) vs active (period). Followers are X's stored profile figure or "غير متوفر"; no reach or engagement is computed. Dominant sentiment needs ≥5 classified posts. Program = the account's most frequent effective program in the window.

**Stories** — approved stories only; a merged story is deleted into its target, so each row is final. Totals count stories, never their posts.

**News** — articles by publication time (discovery time when unknown); program = article's program or its source's. Never added to X totals.

**Team performance** — snapshot (now): unassigned, assigned, in review, escalated, overdue (assigned/in review longer than `queue.wait_warning_minutes`; a visual cue, not an SLA). Period: closed items (distinct items), completed review cycles, reopens, average wait for assignment (entered → assigned), to start (assigned → started), handling (started → closed), to close (entered → closed), per closed cycle. Employees table for team/all scope only.

**AI quality — نسبة الاتفاق مع المراجعة البشرية** — latest review of each item reviewed in the window (a reopened item counts once, by its last review; cycles shown separately). Per field (program, type, main topic, subtopic, sentiment): agreement = reviews where the field was not corrected ÷ reviews where the AI gave a value. Fields the AI left empty are excluded from the denominator. Sample sizes are shown. This is agreement on the reviewed sample, not model accuracy over all data.

**Worth attention** — fixed rules with minimum samples, no model:

| Rule | Fires when |
|---|---|
| Complaints rise | +20% or more, ≥10 now and ≥5 before |
| Negative share | +5 points or more, ≥30 sentiment-classified posts in each window |
| Hashtag growth / new | +50% with ≥5 posts and ≥2 before; or new with ≥8 posts |
| Influencer activity | ≥5 posts and doubled, or newly active |
| Overdue queue items | any overdue item now (queue scope only) |
| AI agreement drop | −10 points or more, ≥20 comparisons in each window |

## Drill-down

`/dashboard/interactions` returns the posts behind a figure using the same filters plus the clicked dimension (bucket, program, topic, subtopic, type, sentiment, hashtag, influencer, story, series). Text is redacted; keyset pagination, newest first. Story drill-down lists the story's visible posts regardless of the window.

## Performance notes

Measured on 100k synthetic posts over 90 days (test database, cache off): most sections 0.1–0.6 s, hashtags ≈1 s, drill-down < 0.2 s. Analytics queries run on a separate small pool with JIT off (`analyticsSql` in `@mip/db`); fragments must never be mixed between `sql` and `analyticsSql`. Partition pruning holds: every partitioned join repeats the window bounds.
