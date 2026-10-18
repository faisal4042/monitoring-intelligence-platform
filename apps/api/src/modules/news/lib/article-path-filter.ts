/**
 * A feed URL (RSS or sitemap) is not proof its entries are all news — a
 * WordPress site's default RSS often exports every post regardless of
 * category (PDFs, governance bylaws, project-phase pages), and a plain
 * sitemap almost always covers the whole site. This is a structural check
 * (does the URL even look like an article?), not a topic filter — genuine
 * topic relevance against monitoring keywords is Phase 4's job, and a
 * News Sitemap <news:news> entry skips this file entirely: the site itself
 * already declared "this is news" via that extension, a stronger signal
 * than any path guess.
 */
// Note the ([/-]|$) boundary after "article(s)" is too loose on its own —
// "/articles-author/..." (a listing page, not an article) satisfies it
// because "-" counts as a valid trailing boundary. NON_ARTICLE_PATH_HINTS is
// checked first in looksLikeArticlePath, so listing-page suffixes like
// "-author"/"-authors" must be excluded explicitly rather than relying on
// the positive match alone.
const ARTICLE_PATH_HINTS = /(^|[/-])(news|article|articles|story|stories|press|press-release|media-center|blog|posts?)([/-]|$)|أخبار|اخبار|مقال|مقالات|خبر|بيان|تقرير|قصة/iu;
const NON_ARTICLE_PATH_HINTS = /(^|[/-])(portfolio|projects?|products?|services?|about(-us)?|contact(-us)?|home|categor(y|ies)|tags?|sitemap|privacy|terms|careers|jobs|pdf(-\d+)?|authors?|writers?|columnists?|articles?-authors?)([/-]|$)/i;

/**
 * Many real newspaper CMSes (aleqt.com is a confirmed real example) put
 * articles under Arabic *section* names — "/التكنولوجيا/...", "/الرأي/..." —
 * with no "news"/"article"/"مقال" keyword anywhere in the path, so
 * ARTICLE_PATH_HINTS alone rejects every single one of them. The one
 * language-independent signal these CMSes share: the last path segment ends
 * in a trailing numeric post ID, and the slug before it reads as an actual
 * multi-word headline rather than a short filename — the same "is this
 * actually readable" bar sitemap.ts's titleFromSlug uses for the inverse
 * purpose (deciding whether a slug is good enough to show as a title).
 */
function hasArticleShapedSlug(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  const match = lastSegment.match(/^(.+)-\d+$/);
  if (!match) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    decoded = match[1];
  }
  const readable = decoded.replace(/[-_]+/g, ' ').trim();
  const letterCount = (readable.match(/\p{L}/gu) ?? []).length;
  const wordCount = readable.split(/\s+/).filter(Boolean).length;
  return wordCount >= 3 && letterCount >= 12;
}

/**
 * Strict — requires a positive "this looks like an article" signal. For
 * sitemap entries, which have no title/content of their own to judge by,
 * so the URL shape is the only signal available at all.
 */
export function looksLikeArticlePath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (NON_ARTICLE_PATH_HINTS.test(path)) return false;
    return ARTICLE_PATH_HINTS.test(path) || hasArticleShapedSlug(path);
  } catch {
    return false;
  }
}

/**
 * Lenient — only rejects an obvious non-article shape. For RSS/Atom
 * entries, which already carry a real title the site chose to syndicate;
 * requiring a positive path match there would reject plenty of genuine
 * articles whose slug just doesn't happen to contain the word "news".
 */
export function isObviouslyNotAnArticle(url: string): boolean {
  try {
    return NON_ARTICLE_PATH_HINTS.test(new URL(url).pathname.toLowerCase());
  } catch {
    return false;
  }
}
