const NO_STORE_PATHS = new Set([
  '/',
  '/index.html',
  '/launch.html',
  '/ngsw.json',
  '/ngsw-worker.js',
  '/sw-composed.js',
  '/safety-worker.js',
  '/worker-basic.min.js',
  '/version.json',
]);

const SHORT_REVALIDATE_PATHS = new Set([
  '/manifest.webmanifest',
  '/.well-known/assetlinks.json',
]);

const HASHED_ENTRY_PATTERNS = [
  /^\/(?:main|polyfills|chunk)[^/]*\.js$/,
  /^\/styles[^/]*\.css$/,
];

const PUBLIC_ASSET_PREFIXES = [
  '/assets/',
  '/fonts/',
  '/icons/',
  '/widgets/',
];

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    return withNanoflowHeaders(request, response);
  },
};

function withNanoflowHeaders(request, response) {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  const path = url.pathname;

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.delete('Link');

  const cacheControl = cacheControlFor(path, headers.get('content-type') ?? '');
  if (cacheControl) {
    headers.set('Cache-Control', cacheControl);
  }

  if (cacheControl?.includes('no-store')) {
    headers.set('Pragma', 'no-cache');
  }

  if (path.endsWith('.map')) {
    headers.set('X-Robots-Tag', 'noindex');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cacheControlFor(path, contentType) {
  if (NO_STORE_PATHS.has(path) || contentType.includes('text/html')) {
    return 'no-store, no-cache, must-revalidate';
  }

  if (path.endsWith('.map')) {
    return 'no-store, no-cache, must-revalidate';
  }

  if (SHORT_REVALIDATE_PATHS.has(path)) {
    return 'public, max-age=300, must-revalidate';
  }

  if (HASHED_ENTRY_PATTERNS.some((pattern) => pattern.test(path))) {
    return 'public, max-age=31536000, immutable';
  }

  if (PUBLIC_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'public, max-age=86400, must-revalidate';
  }

  return null;
}