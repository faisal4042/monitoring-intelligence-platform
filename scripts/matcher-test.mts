import { compileMatcher } from '../packages/x-collector/src/query-match.js';

const cases: Array<[string, Array<[string, boolean]>]> = [
  ['(ايجار OR "منصة إيجار") ("توثيق العقد" OR "العقد ما يتوثق") -"شقة للإيجار"', [
    ['إيجار: العقد ما يتوثق عندي', true],
    ['العقد ما يتوثق عندي', false],
    ['شقة للإيجار في النرجس', false],
  ]],
  ['((ايجار OR "منصة إيجار") OR ("توثيق العقد" OR "العقد ما يتوثق")) -"شقة للإيجار" -"سيارة للإيجار"', [
    ['العقد ما يتوثق عندي', true],
    ['شقة للإيجار في النرجس', false],
    ['سيارة للإيجار يومي وأسبوعي', false],
    ['منصة إيجار ممتازة', true],
  ]],
  ['ايجار -is:retweet lang:ar', [['ايجار زين', true]]],
];

let bad = 0;
for (const [q, tests] of cases) {
  const m = compileMatcher(q);
  console.log(`\n${q.slice(0, 78)}`);
  for (const [text, want] of tests) {
    const got = m({ text, lang: 'ar' });
    if (got !== want) bad++;
    console.log(`  ${got === want ? 'PASS' : 'FAIL'}  "${text.slice(0, 34)}" → ${got}`);
  }
}
console.log(bad ? `\n${bad} حالة فاشلة` : '\nكل حالات المطابقة صحيحة');
process.exit(bad ? 1 : 0);
