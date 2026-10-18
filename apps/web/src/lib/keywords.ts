export function keywordsForGroup<T extends { group_id: string }>(keywords: readonly T[], groupId: string): T[] {
  return keywords.filter(keyword => keyword.group_id === groupId);
}
