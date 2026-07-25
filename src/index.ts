/**
 * @sonn-audio/node-upnp — a UPnP AV toolkit for Node.
 *
 * Three frameworks a host app can drop into its own HTTP server, each free of the
 * app's content or playback model — you inject those through small interfaces:
 *
 *  - {@link UpnpMediaRenderer} — be a renderer: accept SetAVTransportURI/Play from
 *    any control point and drive your own engine via a {@link RendererHandler}.
 *  - {@link UpnpMediaServer} — be a server: answer Browse over your own catalogue
 *    mapped onto neutral DIDL shapes via a {@link ContentProvider}.
 *  - {@link DlnaControlPoint} — be a control point: push a stream URI + DIDL to an
 *    external renderer, with the device-quirk handling baked in.
 *
 * All three advertise themselves on one shared {@link SsdpAdvertiser} (a single
 * :1900 socket serves every device). The lower-level protocol helpers (SOAP,
 * DIDL-Lite, GENA, device/SCPD descriptions, ID3) are exported too, so you can
 * build a device shape the frameworks don't cover.
 */

// ── Logger ────────────────────────────────────────────────────────────────────
export type { UpnpLogger } from './logger.js';
export { noopLogger } from './logger.js';

// ── SSDP (shared discovery/advertising) ─────────────────────────────────────────
export { SsdpAdvertiser } from './ssdp/advertiser.js';
export type { SsdpDevice, SsdpAdvertiserOptions } from './ssdp/advertiser.js';

// ── Frameworks ──────────────────────────────────────────────────────────────────
export { UpnpMediaRenderer, RENDERER_PATHS } from './renderer/mediaRenderer.js';
export type {
  RendererHandler,
  UpnpMediaRendererOptions,
  TransportState,
} from './renderer/mediaRenderer.js';

export { UpnpMediaServer, ROOT_OBJECT_ID, MEDIA_SERVER_PATHS } from './mediaserver/mediaServer.js';
export type {
  ContentProvider,
  UpnpMediaServerOptions,
  BrowseRequest,
  BrowseResult,
  BrowseFlag,
} from './mediaserver/mediaServer.js';

export { DlnaControlPoint } from './controlpoint/controlPoint.js';
export type { DlnaControlPointOptions } from './controlpoint/controlPoint.js';

// ── Control-point discovery ─────────────────────────────────────────────────────
export { resolveDlnaEndpoints, discoverDlnaDevices } from './controlpoint/discovery.js';
export type { DlnaEndpointInfo, DlnaDiscoveredDevice } from './controlpoint/discovery.js';

// ── GENA eventing ───────────────────────────────────────────────────────────────
export { DlnaEventSubscriber } from './gena/eventSubscriber.js';
export type {
  DlnaEventKind,
  DlnaTransportEvent,
  DlnaRenderingEvent,
  DlnaEventHandlers,
  DlnaEventSubscriberOptions,
} from './gena/eventSubscriber.js';

// ── DIDL-Lite (neutral content model) ───────────────────────────────────────────
export {
  buildContainerElement,
  buildItemElement,
  wrapDidl,
  buildDidl,
  readDidlField,
  readDidlDuration,
  parseDidlObject,
} from './didl/didl.js';
export type {
  DidlContainer,
  DidlItem,
  DidlResource,
  ParsedDidlObject,
} from './didl/didl.js';

// ── Device + service descriptions ───────────────────────────────────────────────
export {
  buildDeviceDescription,
  SERVICE_TYPES,
  DEVICE_TYPES,
} from './description/deviceDescription.js';
export type { DeviceIdentity, ServiceRef } from './description/deviceDescription.js';
export {
  CONTENT_DIRECTORY_SCPD,
  CONNECTION_MANAGER_SCPD,
  CONNECTION_MANAGER_SINK_SCPD,
  AV_TRANSPORT_SCPD,
  RENDERING_CONTROL_SCPD,
} from './description/scpd.js';

// ── SOAP primitives ─────────────────────────────────────────────────────────────
export {
  escapeXml,
  unescapeXml,
  parseSoapAction,
  extractTag,
  buildSoapResponse,
  buildSoapRequest,
  buildSoapFault,
  extractFaultCode,
} from './soap/soap.js';

// ── ID3 (for server-side stream tagging) ────────────────────────────────────────
export { buildId3v2Tag } from './media/id3.js';
