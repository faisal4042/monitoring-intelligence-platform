/**
 * Safe sample data for previewing templates in the studio: an invented
 * account and invented posts, never platform data. Shaped like the card API.
 */
import type { CardData, CardPost } from './types';

const post = (i: number, over: Partial<CardPost>): CardPost => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, x_post_id: `190000000000000000${i}`,
  posted_at: `2026-10-${String(14 - i).padStart(2, '0')}T08:${String(10 + i * 7).padStart(2, '0')}:00.000Z`,
  text: '', url: `https://x.com/i/status/190000000000000000${i}`, is_reply: false, is_quote: false,
  relevance: 'relevant', sentiment: 'positive', sentiment_group: 'positive', human_reviewed: false,
  program_id: 'sample', program_name: 'برنامج تجريبي', ...over,
});

export const SAMPLE_CARD: CardData = {
  range: { preset: '30d', from: null, to: null, fromDate: '2026-09-17', toDate: '2026-10-16' },
  current: { from: '2026-09-16T21:00:00.000Z', to: '2026-10-16T21:00:00.000Z' },
  programFilter: null,
  generatedAt: '2026-10-16T09:30:00.000Z',
  account: {
    id: '00000000-0000-4000-8000-000000000000', username: 'sample_account', notes: null, x_author_id: 'sample',
    display_name: 'حساب تجريبي | Sample Account', author_bio: 'حساب وهمي للمعاينة فقط — لا يمثل أي شخص أو جهة حقيقية.',
    followers_count: 25_400, is_verified: true, profile_updated_at: '2026-10-15T10:00:00.000Z',
    x_url: 'https://x.com/sample_account', seen: true, avatar: null,
  },
  figures: {
    posts: 128, relevant: 86, classified: 117, humanReviewed: 9,
    sentiment: { positive: 34, neutral: 41, negative: 39, unclassified: 14, sample: 114, reliable: true }, minSentimentSample: 5,
  },
  program: { id: 'sample', key: 'sample', name_ar: 'برنامج تجريبي', color: '#1fb5b5', posts: 74 },
  recent: [
    post(1, { sentiment: 'negative', sentiment_group: 'negative', human_reviewed: true,
      text: 'تأخر تحديث حالة الطلب منذ أسبوع رغم التواصل مع الدعم أكثر من مرة، أرجو المتابعة وإفادتي بموعد واضح للحل.' }),
    post(2, { relevance: 'irrelevant', sentiment: 'neutral', sentiment_group: 'neutral', is_reply: true, program_name: null,
      text: 'Thanks for the quick update — التحديث الأخير واضح ومفيد #خدمات' }),
    post(3, { text: 'تجربة ممتازة هذا الشهر، تم إنجاز الإجراء خلال دقائق من خلال التطبيق.' }),
  ],
  recentLimit: 5, recentScope: 'all', recentAvailable: 128,
};

/** The sample with a long post and a long link, to try how a template handles long content. */
export const SAMPLE_CARD_LONG: CardData = {
  ...SAMPLE_CARD,
  recent: [
    post(4, { text: `${'نص طويل لاختبار التفاف الأسطر وتوزيع الصفحات في القالب، '.repeat(26)}https://example.com/${'very-long-path-'.repeat(12)}` }),
    ...SAMPLE_CARD.recent,
  ],
};
