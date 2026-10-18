// Preload for live-probe.ts: the ONLY sockets allowed are the isolated test DB (127.0.0.1:5462) and
// www.googleapis.com:443. MIP's database/API and any other host throw before connecting.
import net from 'node:net';
const seen = [];
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'string' || first?.path) return original.apply(this, args);   // local IPC (tsx)
  const host = first?.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost'), port = Number(first?.port ?? args[0]);
  const external = (host === 'www.googleapis.com' || (process.env.PROBE_GUARD_SELFTEST_HOST && host === process.env.PROBE_GUARD_SELFTEST_HOST)) && port === 443;
  const ok = (host === '127.0.0.1' && port === 5462) || external;
  seen.push(`${ok ? 'allow' : 'BLOCK'} ${host}:${port}${external ? ' (IPv4 forced)' : ''}`);
  if (!ok) throw new Error(`live probe egress forbidden: ${host}:${port}`);
  // The API key is restricted to the machine's public IPv4. This host has public IPv6 too and googleapis resolves
  // AAAA first, so without this the request leaves over IPv6 and Google rejects it (first live test, 2026-10-16: 403).
  if (external && typeof first === 'object') { first.family = 4; first.autoSelectFamily = false; }
  if (external) this.once('connect', () => seen.push(`connected ${host} via ${this.remoteFamily} ${this.remoteAddress}:${this.remotePort}`));
  return original.apply(this, args);
};
process.on('exit', () => console.log('PROBE_EGRESS ' + JSON.stringify([...new Set(seen)])));
