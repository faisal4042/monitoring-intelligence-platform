import {useEffect} from 'react';
import {useLocation} from 'react-router-dom';

/** Store only a scroll offset, scoped to the signed-in user and exact filter URL. */
export function useBrowsingScroll(userId: string | undefined, ready: boolean) {
  const location = useLocation();
  const key = `mip:browse-scroll:${userId ?? 'anonymous'}:${location.pathname}${location.search}`;
  useEffect(() => {
    if (!ready || !userId) return;
    let listening = false;
    const save = () => {
      if (listening) {
        try { sessionStorage.setItem(key, String(window.scrollY)); } catch { /* Optional preference. */ }
      }
    };
    const frame = requestAnimationFrame(() => {
      try {
        const value = sessionStorage.getItem(key);
        const offset = value === null ? 0 : Number(value);
        if (Number.isFinite(offset) && offset >= 0) window.scrollTo({top: offset, behavior: 'instant'});
      } catch { /* Browsing remains usable without storage. */ }
      listening = true;
      window.addEventListener('scroll', save, {passive: true});
      window.addEventListener('pagehide', save);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', save);
      window.removeEventListener('pagehide', save);
    };
  }, [key, ready, userId]);
}
