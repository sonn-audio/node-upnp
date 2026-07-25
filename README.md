# @sonn-audio/node-upnp

A UPnP AV toolkit for Node — **protocol only, you inject your own content and
playback.** Zero runtime dependencies.

It gives you three drop-in frameworks plus the lower-level primitives they're
built from. Each framework is free of any app-specific content or playback model:
you supply those through a small interface, and the module handles SSDP discovery,
SOAP control, GENA eventing, DIDL-Lite and the device/SCPD descriptions.

| You want to be a… | Use | You provide |
| --- | --- | --- |
| **MediaServer** (others browse & pull your content) | `UpnpMediaServer` | a `ContentProvider` |
| **MediaRenderer** (others cast to you) | `UpnpMediaRenderer` | a `RendererHandler` |
| **Control point** (you push to an external renderer) | `DlnaControlPoint` | a stream URI + DIDL |

All devices you expose share one `SsdpAdvertiser` — a single `:1900` UDP socket
announces every one of them and answers `M-SEARCH`.

## Install

```sh
npm install @sonn-audio/node-upnp
```

Ships CommonJS (`require`) and ESM (`import`) builds plus `.d.ts` types. Node 18+
(uses global `fetch`, `AbortController`).

## Be a MediaServer

Answer `Browse` over your own catalogue by mapping it onto neutral DIDL shapes.
The module never sees your content model.

```ts
import http from 'node:http';
import { SsdpAdvertiser, UpnpMediaServer, ROOT_OBJECT_ID } from '@sonn-audio/node-upnp';

const provider = {
  async browse(objectId, offset, limit) {
    if (objectId !== ROOT_OBJECT_ID) return { objects: [], total: 0 };
    return {
      objects: [{
        id: 'track/1',
        parentId: ROOT_OBJECT_ID,
        title: 'Ocean Drive',
        artist: 'Demo Artist',
        upnpClass: 'object.item.audioItem.musicTrack',
        resources: [{ url: 'http://host/media/1.mp3', protocolInfo: 'http-get:*:audio/mpeg:*' }],
      }],
      total: 1,
    };
  },
};

const server = new UpnpMediaServer({
  udn: 'uuid:...',
  friendlyName: () => 'My Server',
  baseUrl: () => 'http://192.168.1.10:7799/dms',
  provider,
});

// Route requests under your base path to the framework:
const httpServer = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/dms/')) server.handle(req, res, path.slice('/dms/'.length));
});
httpServer.listen(7799);

const ssdp = new SsdpAdvertiser();
ssdp.addDevice({ udn: server.udn, ...server.deviceTypeAndServices(),
                 location: () => 'http://192.168.1.10:7799/dms/device.xml' });
await ssdp.start();
```

`ContentProvider`:

```ts
interface ContentProvider {
  browse(objectId: string, offset: number, limit: number): Promise<BrowseResult>;
  browseMetadata?(objectId: string): Promise<DidlContainer | DidlItem | null>;
}
```

Return `DidlContainer` for browsable folders, `DidlItem` (with `resources`) for
playable tracks. The module builds and escapes the DIDL-Lite for you.

## Be a MediaRenderer

Accept a cast from any control point and drive your own engine.

```ts
import { UpnpMediaRenderer } from '@sonn-audio/node-upnp';

const renderer = new UpnpMediaRenderer({
  udn: 'uuid:...',
  friendlyName: () => 'My Renderer',
  baseUrl: () => 'http://192.168.1.10:7799/dmr',
  handler: {
    onSetUri: (uri, meta) => console.log('will play', uri, meta?.title),
    onPlay:   (uri, atSec) => myEngine.play(uri, atSec),
    onPause:  () => myEngine.pause(),
    onStop:   () => myEngine.stop(),
    onSeek:   (sec) => myEngine.seek(sec),
    onVolume: (pct) => myEngine.setVolume(pct),
    // Optional: report your real position so controllers show an accurate timeline.
    getPosition: () => ({ elapsed: myEngine.elapsed(), duration: myEngine.duration() }),
  },
});
// Route /dmr/* to renderer.handle(req, res, sub) and advertise it on the SsdpAdvertiser.
```

The renderer answers `GetTransportInfo` / `GetPositionInfo`, pushes GENA
`LastChange` events so controllers reflect play/pause and a timeline, and handles
volume/mute. When your engine changes state outside UPnP, call
`renderer.reflectTransportState(...)` / `renderer.reflectVolume(...)` to push it
back to subscribers.

## Be a control point (push to an external renderer)

Drive an external AVTransport renderer — the inverse of the above. This carries
the hard-won device-quirk handling: silent-timeout-as-accepted on
`SetAVTransportURI`, a `701 TRANSITIONING` retry on `Play`, and strict command
serialization so overlapping Stop/SetURI/Play can't interleave and wedge a device.

```ts
import { DlnaControlPoint, buildDidl } from '@sonn-audio/node-upnp';

const cp = new DlnaControlPoint({ host: '192.168.1.42' }); // or { controlUrl } / autoDiscover
const didl = buildDidl([{
  id: '0', parentId: '-1', title: 'Ocean Drive',
  resources: [{ url: streamUri, protocolInfo: 'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3' }],
}]);

await cp.setUri(streamUri, didl);   // full Stop → SetURI → Play, with the quirks handled
await cp.setVolume(40);

// Optional: receive the renderer's own state (knob turns, app-side play/pause):
await cp.subscribeEvents({
  onTransport: (e) => console.log('device state', e.transportState),
  onRendering: (e) => console.log('device volume', e.volume),
}, myLanIp);
```

## Lower-level primitives

Exported for building device shapes the frameworks don't cover:

- **SSDP** — `SsdpAdvertiser`, `resolveDlnaEndpoints`, `discoverDlnaDevices`
- **DIDL-Lite** — `buildDidl`, `buildItemElement`, `buildContainerElement`,
  `parseDidlObject`, `readDidlField`, `readDidlDuration`
- **SOAP** — `escapeXml`, `parseSoapAction`, `extractTag`, `buildSoapResponse`,
  `buildSoapRequest`, `buildSoapFault`, `extractFaultCode`
- **GENA** — `DlnaEventSubscriber`
- **Descriptions** — `buildDeviceDescription`, `SERVICE_TYPES`, `DEVICE_TYPES`, and
  the standard SCPD constants (`AV_TRANSPORT_SCPD`, `CONTENT_DIRECTORY_SCPD`, …)
- **ID3** — `buildId3v2Tag` (prepend now-playing tags to a tagless MP3 stream so a
  pulling renderer reads title/artist from the audio itself)

Inject an optional `logger` (`{ debug?, info?, warn?, error? }`) into any of them;
omit it and the module is silent.

## Runnable demo

[`examples/demo-server.mjs`](examples/demo-server.mjs) stands up a MediaServer and
a MediaRenderer on one HTTP server + one advertiser, using a made-up two-track
catalogue. Build, run, then point any DLNA control point at your LAN:

```sh
npm run build && node examples/demo-server.mjs
```

## License

MIT
