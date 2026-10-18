/** Local IPC only: no HTTP administration endpoint, no signal emulation on Windows. */
export function installParentControl(close: () => Promise<void>) {
  if (process.env.MIP_MANAGED_PARENT !== '1') return;
  if (!process.send || !process.connected) throw new Error('Managed startup requires parent IPC');
  let closing: Promise<void> | undefined;
  const stop = () => closing ??= close().then(() => {
    if (process.connected) process.send?.({type:'mip:drained'}, () => process.exit(0));
    else process.exit(0);
  }, error => {
    if (process.connected) process.send?.({type:'mip:shutdown-failed',message:String(error)});
    process.exitCode = 1;
  });
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'mip:stop') void stop();
  });
  process.on('disconnect', () => { void stop(); });
}
