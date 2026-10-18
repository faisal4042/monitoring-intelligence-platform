import { createElement, use, useEffect, type ComponentType } from 'react';
import { matchPath } from 'react-router-dom';
import { canAccessRoute } from './route-access';

type PageModule = { default: ComponentType };
type Tracked = Promise<PageModule> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: PageModule; reason?: unknown };
export type RouteModule = ComponentType & { preload: () => Promise<PageModule> };

/**
 * React.lazy cannot see a module that was already fetched, so a preloaded page
 * would still suspend once. This loader tags its promise the way React's use()
 * reads it: once fulfilled, the page renders synchronously.
 */
export function routeModule(load: () => Promise<PageModule>): RouteModule {
  let pending: Tracked | undefined;
  let rendered = false;
  const start = () => {
    const promise: Tracked = load();
    promise.status = 'pending';
    promise.then(
      (value) => { promise.status = 'fulfilled'; promise.value = value; },
      (reason) => { promise.status = 'rejected'; promise.reason = reason; },
    );
    rendered = false;
    return (pending = promise);
  };
  // A render reuses its own failure so the route error boundary shows it instead
  // of React re-rendering into a new fetch. Intent asks again after a failure, but
  // a browser may remember a failed module for the document's life (Chrome does);
  // the boundary's reload is then the recovery, as with React.lazy.
  const preload = () => (!pending || pending.status === 'rejected' ? start() : pending);
  const forRender = (): Promise<PageModule> => {
    const promise = !pending || (pending.status === 'rejected' && !rendered) ? start() : pending;
    rendered = true;
    return promise;
  };
  const Page = () => createElement(use(forRender()).default);
  return Object.assign(Page, { preload });
}

const INTENT_DELAY_MS = 80;

/**
 * Preloads one page when a pointer rests on, or focus lands on, a link to it.
 * Pressing (mouse, pen or touch) loads immediately; no page is loaded without
 * intent, and never one the user's permissions exclude.
 */
export function useIntentPrefetch(pages: readonly (readonly [string, RouteModule])[], permissions: readonly string[]) {
  useEffect(() => {
    const target = (event: Event) => {
      // Offline, a preload can only fail, and the failed module could outlive the
      // reconnect; the click itself then loads the page as it would without intent.
      if (!navigator.onLine) return null;
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.origin !== window.location.origin || link.pathname === window.location.pathname) return null;
      const page = pages.find(([path]) => matchPath(path, link.pathname));
      return page && canAccessRoute(page[0], permissions) ? { link, page: page[1] } : null;
    };
    const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed: Element | null = null;
    const cancel = () => { clearTimeout(timer); armed = null; };
    const arm = (event: Event) => {
      const hit = target(event);
      if (!hit || hit.link === armed || saveData()) return;
      cancel();
      armed = hit.link;
      timer = setTimeout(() => { void hit.page.preload(); armed = null; }, INTENT_DELAY_MS);
    };
    const leave = (event: Event) => {
      const next = (event as FocusEvent | PointerEvent).relatedTarget as Node | null;
      if (armed && !(next && armed.contains(next))) cancel();
    };
    const onPointerOver = (event: PointerEvent) => { if (event.pointerType !== 'touch') arm(event); };
    const onPointerDown = (event: PointerEvent) => { void target(event)?.page.preload(); };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', arm);
    document.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      cancel();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusin', arm);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [pages, permissions]);
}
