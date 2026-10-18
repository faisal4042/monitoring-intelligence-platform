import { z } from 'zod';

/**
 * Query AST — the contract shared by the visual Query Builder (web) and the
 * compiler (api). See docs/ARCHITECTURE.md §4.3.
 *
 * KEYWORD_GROUP is a *reference*, not inlined text: editing the dictionary
 * updates every query that uses it, with no per-query edits.
 */
export type QueryNode =
  | { op: 'AND'; children: QueryNode[] }
  | { op: 'OR'; children: QueryNode[] }
  | { op: 'NOT'; child: QueryNode }
  | { op: 'TERM'; value: string }
  | { op: 'PHRASE'; value: string }
  | { op: 'HASHTAG'; value: string }
  | { op: 'FROM'; value: string }
  | { op: 'TO'; value: string }
  | { op: 'MENTION'; value: string }
  | { op: 'KEYWORD_GROUP'; groupId: string }
  | { op: 'FILTER'; key: 'lang' | 'is:retweet' | 'is:reply' | 'is:quote' | 'has:links' | 'has:media'; value?: string };

export const queryNodeSchema: z.ZodType<QueryNode> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('AND'), children: z.array(queryNodeSchema).min(1) }),
    z.object({ op: z.literal('OR'), children: z.array(queryNodeSchema).min(1) }),
    z.object({ op: z.literal('NOT'), child: queryNodeSchema }),
    z.object({ op: z.literal('TERM'), value: z.string().min(1) }),
    z.object({ op: z.literal('PHRASE'), value: z.string().min(1) }),
    z.object({ op: z.literal('HASHTAG'), value: z.string().min(1) }),
    z.object({ op: z.literal('FROM'), value: z.string().min(1) }),
    z.object({ op: z.literal('TO'), value: z.string().min(1) }),
    z.object({ op: z.literal('MENTION'), value: z.string().min(1) }),
    z.object({ op: z.literal('KEYWORD_GROUP'), groupId: z.string().uuid() }),
    z.object({
      op: z.literal('FILTER'),
      key: z.enum(['lang', 'is:retweet', 'is:reply', 'is:quote', 'has:links', 'has:media']),
      value: z.string().optional(),
    }),
  ]) as z.ZodType<QueryNode>,
);

export interface QueryEstimate {
  breadthScore: number;      // 0-100, higher = broader
  noiseRiskScore: number;    // 0-100, higher = more expected noise
  estimatedUnitsPerRun: number;
  compiledLength: number;
  warnings: Array<{ severity: 'info' | 'warning' | 'critical'; messageAr: string }>;
}
