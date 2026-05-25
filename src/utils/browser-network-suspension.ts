const NETWORK_VISIBLE_RESUME_GRACE_MS = 1500;
const NETWORK_ONLINE_RESUME_GRACE_MS = 5000;
const NETWORK_ERROR_RESUME_GRACE_MS = 5000;
const BROWSER_NETWORK_SUSPENDED_ERROR_NAME = 'BrowserNetworkSuspendedError';
const BROWSER_NETWORK_SUSPENDED_ERROR_MESSAGE = 'Browser network IO suspended';

let trackingInitialized = false;
let networkBlockedUntil = 0;
let visibilityChangeHandler: (() => void) | null = null;
let pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
let onlineHandler: (() => void) | null = null;

function armNetworkResumeGrace(graceMs = NETWORK_VISIBLE_RESUME_GRACE_MS): void {
  networkBlockedUntil = Math.max(networkBlockedUntil, Date.now() + graceMs);
}

export function ensureBrowserNetworkSuspensionTracking(): void {
  if (trackingInitialized || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  visibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      armNetworkResumeGrace();
    }
  };

  pageShowHandler = (event: PageTransitionEvent) => {
    if (event.persisted) {
      armNetworkResumeGrace(NETWORK_ONLINE_RESUME_GRACE_MS);
    }
  };

  onlineHandler = () => {
    armNetworkResumeGrace(NETWORK_ONLINE_RESUME_GRACE_MS);
  };

  document.addEventListener('visibilitychange', visibilityChangeHandler);
  window.addEventListener('pageshow', pageShowHandler as EventListener);
  window.addEventListener('online', onlineHandler);
  trackingInitialized = true;
}

export function isBrowserNetworkSuspendedWindow(): boolean {
  ensureBrowserNetworkSuspensionTracking();

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    return true;
  }

  return Date.now() < networkBlockedUntil;
}

export function getRemainingBrowserNetworkResumeDelayMs(): number {
  ensureBrowserNetworkSuspensionTracking();
  return Math.max(0, networkBlockedUntil - Date.now());
}

export function createBrowserNetworkSuspendedError(): Error {
  const error = new Error(BROWSER_NETWORK_SUSPENDED_ERROR_MESSAGE);
  error.name = BROWSER_NETWORK_SUSPENDED_ERROR_NAME;
  return error;
}

export function resetBrowserNetworkSuspensionTrackingForTests(): void {
  if (typeof document !== 'undefined' && visibilityChangeHandler) {
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
  }

  if (typeof window !== 'undefined' && pageShowHandler) {
    window.removeEventListener('pageshow', pageShowHandler as EventListener);
  }

  if (typeof window !== 'undefined' && onlineHandler) {
    window.removeEventListener('online', onlineHandler);
  }

  visibilityChangeHandler = null;
  pageShowHandler = null;
  onlineHandler = null;
  networkBlockedUntil = 0;
  trackingInitialized = false;
}

export function isBrowserNetworkSuspendedError(error: unknown): boolean {
  if ((error as { name?: string } | null)?.name === BROWSER_NETWORK_SUSPENDED_ERROR_NAME) {
    armNetworkResumeGrace(NETWORK_ERROR_RESUME_GRACE_MS);
    return true;
  }

  const message = String((error as { message?: string })?.message ?? error ?? '').toLowerCase();
  const suspended = message.includes('network_io_suspended') || message.includes('network io suspended');
  if (suspended) {
    armNetworkResumeGrace(NETWORK_ERROR_RESUME_GRACE_MS);
  }
  return suspended;
}
