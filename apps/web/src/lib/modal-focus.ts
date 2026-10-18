type Layer = { root: HTMLElement; panel: HTMLElement; opener: HTMLElement | null; dismiss: () => void; busy: () => boolean; lastFocus: HTMLElement | null };
const managers = new WeakMap<Document, ReturnType<typeof createManager>>();

export function focusableElements(panel: HTMLElement): HTMLElement[] {
  const nodes = [...panel.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"]')]
    .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0
      && !['hidden', 'collapse'].includes(panel.ownerDocument.defaultView!.getComputedStyle(node).visibility));
  return nodes.filter(node => {
    if (!(node instanceof panel.ownerDocument.defaultView!.HTMLInputElement) || node.type !== 'radio' || !node.name) return true;
    const group = nodes.filter(other => other instanceof panel.ownerDocument.defaultView!.HTMLInputElement && other.type === 'radio' && other.name === node.name && other.form === node.form) as HTMLInputElement[];
    return node === (group.find(radio => radio.checked) ?? group[0]);
  }).sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}

function createManager(doc: Document) {
  const layers: Layer[] = [];
  const snapshots = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
  let overflow = '';
  const top = () => layers.at(-1);
  const focus = (layer: Layer) => {
    const nodes = focusableElements(layer.panel);
    const preferred = layer.panel.querySelector<HTMLElement>('[data-dialog-initial-focus],[autofocus]');
    const active = doc.activeElement as HTMLElement | null;
    (preferred && nodes.includes(preferred) ? preferred
      : active && nodes.includes(active) ? active : nodes[0] ?? layer.panel).focus();
  };
  const isolate = () => {
    const active = top();
    for (const node of Array.from(doc.body.children)) {
      if (!(node instanceof doc.defaultView!.HTMLElement)) continue;
      if (!snapshots.has(node)) snapshots.set(node, { inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') });
      if (node === active?.root) { node.inert = false; node.removeAttribute('aria-hidden'); }
      else { node.inert = true; node.setAttribute('aria-hidden', 'true'); }
    }
    layers.forEach((layer, i) => { layer.root.style.zIndex = String(1000 + i); });
  };
  const key = (event: KeyboardEvent) => {
    const layer = top();
    if (!layer || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!layer.busy()) layer.dismiss();
    } else if (event.key === 'Tab') {
      const nodes = focusableElements(layer.panel), first = nodes[0], last = nodes.at(-1);
      const active = doc.activeElement;
      if (!first) { event.preventDefault(); layer.panel.focus(); }
      else if (!layer.panel.contains(active) || active === layer.panel) { event.preventDefault(); (event.shiftKey ? last! : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last!.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }
  };
  const focusIn = (event: FocusEvent) => {
    const layer = top();
    if (!layer) return;
    const target = event.target as HTMLElement;
    if (layer.panel.contains(target)) layer.lastFocus = target;
    else if (layer.lastFocus && focusableElements(layer.panel).includes(layer.lastFocus)) layer.lastFocus.focus();
    else focus(layer);
  };
  const observer = new doc.defaultView!.MutationObserver(isolate);
  return {
    add(layer: Layer) {
      if (!layers.length) {
        overflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden';
        doc.addEventListener('keydown', key); doc.addEventListener('focusin', focusIn);
        observer.observe(doc.body, { childList: true });
      }
      layers.push(layer); isolate(); focus(layer);
      return () => {
        const wasTop = top() === layer;
        const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1);
        if (!layers.length) {
          observer.disconnect(); doc.removeEventListener('keydown', key); doc.removeEventListener('focusin', focusIn);
          doc.body.style.overflow = overflow;
          for (const [node, value] of snapshots) {
            node.inert = value.inert;
            if (value.ariaHidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', value.ariaHidden);
          }
          snapshots.clear();
        } else isolate();
        if (wasTop) {
          const next = top();
          if (layer.opener?.isConnected && (!next || next.panel.contains(layer.opener)) && !layer.opener.closest('[inert]')) layer.opener.focus();
          else if (next) focus(next);
        }
      };
    },
    dismiss(root: HTMLElement) { const layer = top(); if (layer?.root === root && !layer.busy()) layer.dismiss(); },
  };
}

export function registerModal(layer: Omit<Layer, 'lastFocus'>) {
  const doc = layer.root.ownerDocument;
  let manager = managers.get(doc);
  if (!manager) { manager = createManager(doc); managers.set(doc, manager); }
  return manager.add({ ...layer, lastFocus: null });
}
export function dismissModal(root: HTMLElement) { managers.get(root.ownerDocument)?.dismiss(root); }
