/** Frozen compatibility fallback only. Never imports the original v1 startup path. */
await import('./server-local-legacy-transition.js');
export {};
