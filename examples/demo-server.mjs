// A self-contained consumer of @sonn-audio/node-upnp — proves the module is usable
// by an app that knows nothing about lox-audioserver. It stands up a UPnP
// MediaServer (browse a tiny made-up catalogue) and a MediaRenderer (accept a cast
// and "play" it by logging), both on one HTTP server and one SSDP advertiser.
//
//   npm run build && node examples/demo-server.mjs
//
// Then point any DLNA control point (BubbleUPnP, VLC → "demo server", Hi-Fi app) at
// the LAN. Browsing shows two tracks; casting to "Demo Renderer" logs the URI.

import http from 'node:http';
import os from 'node:os';
import {
  SsdpAdvertiser,
  UpnpMediaServer,
  UpnpMediaRenderer,
  ROOT_OBJECT_ID,
} from '../dist/esm/index.js';

const PORT = 7799;

// Pick a LAN IPv4 so LOCATION URLs are reachable by other devices.
function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
const HOST = lanIp();
const base = (p) => `http://${HOST}:${PORT}${p}`;

const logger = {
  debug: (m, meta) => console.log('[dbg]', m, meta ?? ''),
  info: (m, meta) => console.log('[inf]', m, meta ?? ''),
  warn: (m, meta) => console.warn('[wrn]', m, meta ?? ''),
};

// ── A made-up content catalogue (the app's own model, mapped to DIDL shapes) ──────
const TRACKS = [
  {
    id: 'track/1',
    title: 'Ocean Drive',
    artist: 'Demo Artist',
    album: 'Neutral Sessions',
    url: base('/media/track-1.mp3'),
  },
  {
    id: 'track/2',
    title: 'Night Shift',
    artist: 'Demo Artist',
    album: 'Neutral Sessions',
    url: base('/media/track-2.mp3'),
  },
];

/** ContentProvider: the module asks, the app answers with neutral DIDL shapes. */
const provider = {
  async browse(objectId, offset, limit) {
    if (objectId === ROOT_OBJECT_ID) {
      const objects = TRACKS.slice(offset, offset + limit).map((t) => ({
        id: t.id,
        parentId: ROOT_OBJECT_ID,
        title: t.title,
        artist: t.artist,
        album: t.album,
        upnpClass: 'object.item.audioItem.musicTrack',
        resources: [{ url: t.url, protocolInfo: 'http-get:*:audio/mpeg:*' }],
      }));
      return { objects, total: TRACKS.length };
    }
    return { objects: [], total: 0 };
  },
  async browseMetadata(objectId) {
    const t = TRACKS.find((x) => x.id === objectId);
    if (!t) return null;
    return {
      id: t.id,
      parentId: ROOT_OBJECT_ID,
      title: t.title,
      artist: t.artist,
      album: t.album,
      upnpClass: 'object.item.audioItem.musicTrack',
      resources: [{ url: t.url, protocolInfo: 'http-get:*:audio/mpeg:*' }],
    };
  },
};

const advertiser = new SsdpAdvertiser({ serverHeader: 'demo/1.0 UPnP/1.0', logger });

const server = new UpnpMediaServer({
  udn: 'uuid:demo-server-0000-0000-000000000001',
  friendlyName: () => 'Demo Server',
  baseUrl: () => base('/dms'),
  provider,
  logger,
});

const renderer = new UpnpMediaRenderer({
  udn: 'uuid:demo-renderer-0000-0000-00000001',
  friendlyName: () => 'Demo Renderer',
  baseUrl: () => base('/dmr'),
  handler: {
    onSetUri: (uri, meta) => console.log('renderer ← SetURI', uri, meta?.title ?? ''),
    onPlay: (uri, at) => console.log('renderer ▶ PLAY', uri, at != null ? `@${at}s` : ''),
    onPause: () => console.log('renderer ⏸ PAUSE'),
    onStop: () => console.log('renderer ⏹ STOP'),
    onVolume: (v) => console.log('renderer 🔊', v),
  },
  logger,
});

// ── One HTTP server routes to both devices by path prefix ────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', base(''));
  const path = url.pathname;
  if (path.startsWith('/dms/')) return void server.handle(req, res, path.slice('/dms/'.length));
  if (path.startsWith('/dmr/')) return void renderer.handle(req, res, path.slice('/dmr/'.length));
  if (path.startsWith('/media/')) {
    // The app serves its own audio however it likes. For the demo, 404 (no real bytes).
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return void res.end('demo: no audio bytes');
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, async () => {
  console.log(`demo UPnP host on http://${HOST}:${PORT}`);
  console.log(`  MediaServer  device.xml → ${base('/dms/device.xml')}`);
  console.log(`  MediaRenderer device.xml → ${base('/dmr/device.xml')}`);
  advertiser.addDevice({
    udn: server.udn,
    ...server.deviceTypeAndServices(),
    location: () => base('/dms/device.xml'),
  });
  advertiser.addDevice({
    udn: renderer.udn,
    ...renderer.deviceTypeAndServices(),
    location: () => base('/dmr/device.xml'),
  });
  await advertiser.start();
  console.log('SSDP advertising; discoverable by any DLNA control point.');
});

process.on('SIGINT', async () => {
  await advertiser.stop();
  httpServer.close();
  renderer.dispose();
  process.exit(0);
});
