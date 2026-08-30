import { sql } from '@mip/db';
import { classify, loadDictionary } from '../apps/api/src/modules/classification/classifier.js';

const cases = [
  ['ejar', '@Ejar_Sa العقد معلق والدفعة لم تصل حتى الآن'],
  ['ejar', '@Ejar_Sa تمويل شخصي وإعادة تمويل للتواصل واتساب 0551234567'],
  ['rega', '@REGA_CARES لدي بلاغ على وسيط عقاري ولم تتم معالجته'],
  ['mullak', '@Mullak_SA لا أستطيع تحديث بيانات جمعية الملاك'],
  ['mostadam', '@Mostadam_SA فاحص مباني للتواصل واتساب 0551234567 وللطلب عبر الرابط'],
  ['mostadam', 'البناء المستدام مهم لجودة الحياة في كل دول العالم'],
] as const;

async function main() {
  for (const [programKey, text] of cases) {
    const [program] = await sql<{ id: string }[]>`
      SELECT id FROM programs WHERE key = ${programKey}`;
    const result = classify(text, await loadDictionary(program.id));
    console.log(JSON.stringify({ programKey, text, relevance: result.relevance, matchedTerms: result.matchedTerms }));
  }

  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
