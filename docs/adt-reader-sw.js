const READER_MARKER = '/__adt_reader__/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function projectRequest(url) {
  const markerIndex = url.pathname.indexOf(READER_MARKER);
  if (markerIndex < 0) return null;
  const pieces = url.pathname.slice(markerIndex + READER_MARKER.length).split('/');
  const session = decodeURIComponent(pieces.shift() || '');
  const path = pieces.map((piece) => decodeURIComponent(piece)).join('/') || 'index.html';
  return session && path ? { session, path } : null;
}

function requestFromTool(session, path) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => new Promise((resolve) => {
    let complete = false;
    const finish = (value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 10000);
    for (const client of windows) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const reply = event.data;
        if (reply?.session === session) finish(reply);
      };
      client.postMessage({ type: 'adt-reader/request', session, path }, [channel.port2]);
    }
    if (!windows.length) finish(null);
  }));
}

function rangedResponse(blob, request, contentType) {
  const range = request.headers.get('range');
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': contentType || blob.type || 'application/octet-stream'
  });
  if (!range) {
    headers.set('Content-Length', String(blob.size));
    return new Response(blob, { status: 200, headers });
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return new Response(null, { status: 416, headers });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= blob.size) {
    headers.set('Content-Range', `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }
  const partial = blob.slice(start, end + 1, contentType || blob.type);
  headers.set('Content-Length', String(partial.size));
  headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
  return new Response(partial, { status: 206, headers });
}

self.addEventListener('fetch', (event) => {
  const requested = projectRequest(new URL(event.request.url));
  if (!requested) return;
  event.respondWith((async () => {
    const reply = await requestFromTool(requested.session, requested.path);
    if (!reply?.ok || !(reply.blob instanceof Blob)) {
      return new Response(reply?.error || `ADT file not found: ${requested.path}`, {
        status: reply?.status || 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    return rangedResponse(reply.blob, event.request, reply.contentType);
  })());
});
