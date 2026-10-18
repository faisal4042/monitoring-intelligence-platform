import {useBrowsingParams} from './useBrowsingParams';
import {useLocation} from 'react-router-dom';
import { boundedPage } from './data-browsing';

type Position = { cursor: string; page: number };
type Trail = { scope: string; positions: Position[] };

/** URL holds the actual server cursor; history state holds visited previous cursors. */
export function useCursorNavigation(scope: string, firstPage = 1) {
  const [params, setParams] = useBrowsingParams();
  const location = useLocation();
  const cursor = params.get('cursor') ?? '';
  const page = cursor ? boundedPage(params.get('page'), Number.MAX_SAFE_INTEGER) : firstPage;
  const saved = location.state?.cursorTrail as Trail | undefined;
  const positions = saved?.scope === scope && Array.isArray(saved.positions) ? saved.positions : [];
  const move = (position: Position, trail: Position[]) => setParams(old => {
    const next = new URLSearchParams(old);
    position.cursor ? next.set('cursor', position.cursor) : next.delete('cursor');
    position.page > 1 ? next.set('page', String(position.page)) : next.delete('page');
    next.delete('item'); next.delete('detail'); next.delete('detailSection');
    return next;
  }, { state: { ...location.state, cursorTrail: { scope, positions: trail } } });
  return {
    cursor, page, pageKnown:!cursor||Number.isSafeInteger(Number(params.get('page')))&&Number(params.get('page'))>0, canPrevious: positions.length > 0,
    next: (nextCursor: string) => { if (nextCursor && nextCursor !== cursor) move({ cursor: nextCursor, page: page + 1 }, [...positions, { cursor, page }]); },
    previous: () => { const previous = positions.at(-1); if (previous) move(previous, positions.slice(0, -1)); },
    first: () => move({ cursor: '', page: 1 }, []),
  };
}
