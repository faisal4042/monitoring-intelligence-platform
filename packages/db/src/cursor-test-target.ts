/** No config/.env imports: validate the explicit fixture URL before opening a pool. */
export function assertCursorTestTarget(raw: string, expected: string): URL {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      !/^mip_cursor_[a-z0-9_]+_test$/.test(expected) || url.pathname !== '/' + expected ||
      url.search || url.hash || process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing cursor fixture operation: explicit isolated test target required');
  }
  return url;
}
