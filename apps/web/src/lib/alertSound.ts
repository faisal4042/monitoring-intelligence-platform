/**
 * The alert chime: two short soft tones synthesized with Web Audio, so there
 * is no asset to load and nothing to fail on the network.
 *
 * Browsers start audio "suspended" until the user interacts with the page.
 * A chime is only reported as played when the context is actually running;
 * otherwise the caller keeps showing the visual alert and offers a button to
 * enable sound. Nothing here ever throws to the caller.
 */
type Listener = (state: AudioState) => void;
export type AudioState = 'running' | 'blocked' | 'unsupported';

let ctx: AudioContext | null = null;
const listeners = new Set<Listener>();
let lastChime = 0;
/** Several alerts close together make one sound, at most one per this window. */
export const CHIME_MIN_GAP_MS = 8000;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    ctx.onstatechange = () => notify();
    return ctx;
  } catch { return null; }
}

export function audioState(): AudioState {
  const c = context();
  if (!c) return 'unsupported';
  return c.state === 'running' ? 'running' : 'blocked';
}

function notify() { const s = audioState(); listeners.forEach((l) => l(s)); }
export function onAudioState(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Must be called from a user gesture (click/keydown) to lift the autoplay block. */
export async function unlockAudio(): Promise<boolean> {
  const c = context();
  if (!c) return false;
  try { if (c.state !== 'running') await c.resume(); } catch { /* still blocked */ }
  notify();
  return c.state === 'running';
}

/**
 * Plays the chime unless blocked or rate-limited. Returns whether it played.
 * `force` (the "test sound" button) ignores the rate limit.
 */
export function chime(volume: number, force = false): boolean {
  const c = context();
  if (!c || c.state !== 'running') return false;
  const now = Date.now();
  if (!force && now - lastChime < CHIME_MIN_GAP_MS) return false;
  try {
    const peak = Math.max(0, Math.min(1, volume)) * 0.18; // soft by design, never loud
    if (peak <= 0) return false;
    const t0 = c.currentTime;
    for (const [i, freq] of [[0, 880], [1, 1320]] as const) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    }
    lastChime = now;
    return true;
  } catch { return false; }
}
