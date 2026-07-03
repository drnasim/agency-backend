const express = require('express');
const { Readable } = require('stream');

const router = express.Router();

const SERVER_2_ORIGIN = 'http://www.tv.iptv24bd.live';
const SERVER_2_REFERER = `${SERVER_2_ORIGIN}/`;
const STREAM_ORIGIN = 'http://51.79.251.252:7171';
const SERVER_2_PROXY_PREFIX = '/api/live-tv/server-2';
const STREAM_PROXY_PREFIX = '/api/live-tv/server-2-stream';
const REQUEST_TIMEOUT_MS = 12000;

const TEXT_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'text/javascript',
  'application/x-javascript'
];

const isTextResponse = (contentType = '') => (
  TEXT_CONTENT_TYPES.some(type => contentType.toLowerCase().includes(type))
);

const isHlsResponse = (contentType = '', pathname = '') => (
  contentType.toLowerCase().includes('mpegurl') || pathname.toLowerCase().endsWith('.m3u8')
);

const buildHeaders = (req, referer = SERVER_2_REFERER) => {
  const headers = {
    'User-Agent': req.get('User-Agent') || 'Mozilla/5.0',
    Accept: req.get('Accept') || '*/*',
    'Accept-Language': req.get('Accept-Language') || 'en-US,en;q=0.9',
    Referer: referer
  };

  const range = req.get('Range');
  if (range) headers.Range = range;

  return headers;
};

const fetchWithTimeout = async (url, req, referer) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: buildHeaders(req, referer),
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const getTargetUrlFromRequest = (req, proxyPrefix, origin) => {
  const requestUrl = new URL(req.originalUrl, 'https://fortivus.local');
  const targetPath = requestUrl.pathname.slice(proxyPrefix.length) || '/';
  return new URL(`${targetPath}${requestUrl.search}`, origin);
};

const proxyStreamPath = (url) => {
  const upstream = url instanceof URL ? url : new URL(url);
  return `${STREAM_PROXY_PREFIX}${upstream.pathname}${upstream.search}`;
};

const rewriteHtmlOrAsset = (body) => (
  body
    .replaceAll(SERVER_2_ORIGIN, SERVER_2_PROXY_PREFIX)
    .replaceAll(STREAM_ORIGIN, STREAM_PROXY_PREFIX)
    .replace(/((?:src|href|action)=["'])\/(?!\/|api\/live-tv\/)/gi, `$1${SERVER_2_PROXY_PREFIX}/`)
    .replace(/(url\(\s*['"]?)\/(?!\/|api\/live-tv\/)/gi, `$1${SERVER_2_PROXY_PREFIX}/`)
);

const rewriteHlsPlaylist = (body, targetUrl) => (
  body.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();

    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const nextUrl = new URL(uri, targetUrl);
        return nextUrl.origin === STREAM_ORIGIN ? `URI="${proxyStreamPath(nextUrl)}"` : `URI="${uri}"`;
      });
    }

    const nextUrl = new URL(trimmed, targetUrl);
    return nextUrl.origin === STREAM_ORIGIN ? proxyStreamPath(nextUrl) : line;
  }).join('\n')
);

const copyResponseHeaders = (upstreamResponse, res, omitContentLength = false) => {
  const allowedHeaders = [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified'
  ];

  allowedHeaders.forEach((header) => {
    if (omitContentLength && header === 'content-length') return;
    const value = upstreamResponse.headers.get(header);
    if (value) res.set(header, value);
  });
};

const sendProxyResponse = async (req, res, targetUrl, options = {}) => {
  try {
    const upstreamResponse = await fetchWithTimeout(targetUrl, req, options.referer);
    const contentType = upstreamResponse.headers.get('content-type') || '';
    const shouldRewriteHls = options.rewriteHls && isHlsResponse(contentType, targetUrl.pathname);
    const shouldRewriteText = options.rewriteText && isTextResponse(contentType);

    if (shouldRewriteHls || shouldRewriteText) {
      const text = await upstreamResponse.text();
      const body = shouldRewriteHls
        ? rewriteHlsPlaylist(text, targetUrl)
        : rewriteHtmlOrAsset(text);

      copyResponseHeaders(upstreamResponse, res, true);
      res.set('Content-Type', contentType || (shouldRewriteHls ? 'application/vnd.apple.mpegurl' : 'text/plain'));
      res.set('Cache-Control', shouldRewriteHls ? 'no-cache' : 'public, max-age=300');
      return res.status(upstreamResponse.status).send(body);
    }

    copyResponseHeaders(upstreamResponse, res);
    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
      return res.send(buffer);
    }

    return Readable.fromWeb(upstreamResponse.body).pipe(res);
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    return res.status(isTimeout ? 504 : 502).send(
      isTimeout ? 'Live TV server timed out.' : 'Live TV server is temporarily unavailable.'
    );
  }
};

router.get('/server-2', (req, res, next) => {
  if (req.path.endsWith('/')) return next();
  res.redirect(302, `${SERVER_2_PROXY_PREFIX}/`);
});

router.get('/server-2/*', (req, res) => {
  const targetUrl = getTargetUrlFromRequest(req, SERVER_2_PROXY_PREFIX, SERVER_2_ORIGIN);
  return sendProxyResponse(req, res, targetUrl, {
    referer: SERVER_2_REFERER,
    rewriteText: true
  });
});

router.get('/server-2-stream/*', (req, res) => {
  const targetUrl = getTargetUrlFromRequest(req, STREAM_PROXY_PREFIX, STREAM_ORIGIN);
  return sendProxyResponse(req, res, targetUrl, {
    referer: SERVER_2_REFERER,
    rewriteHls: true
  });
});

module.exports = router;
