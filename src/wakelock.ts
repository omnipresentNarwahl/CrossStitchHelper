/**
 * Keeps the phone screen on while stitching. The browser drops the lock whenever the page is
 * hidden, so we ask for it again each time the app comes back to the foreground.
 */
let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function request(): Promise<void> {
  if (!wanted || sentinel || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null;
  }
}

document.addEventListener('visibilitychange', () => void request());

export const wakeLockSupported = 'wakeLock' in navigator;

export function keepAwake(on: boolean): void {
  wanted = on;
  if (on) void request();
  else {
    void sentinel?.release();
    sentinel = null;
  }
}
