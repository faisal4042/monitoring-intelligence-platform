import postgres from 'postgres';
import {assertCursorTestTarget} from '../src/cursor-test-target.js';
import {backfillNewsTitles} from '../src/backfill-news-titles.js';

const raw = process.env.CURSOR_TEST_DATABASE_URL ?? '';
const expected = process.env.CURSOR_TEST_DATABASE_NAME ?? '';
const marker = process.env.CURSOR_TEST_MARKER;
assertCursorTestTarget(raw, expected);
if (!marker) throw new Error('Explicit independent fixture marker required');
const sql = postgres(raw, {max: 1, onnotice: () => {}});
try { console.log(JSON.stringify(await backfillNewsTitles(sql, expected, marker))); }
finally { await sql.end(); }
