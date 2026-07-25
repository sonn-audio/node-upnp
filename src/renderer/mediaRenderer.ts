import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import type { UpnpLogger } from '../logger.js';
import {
  buildSoapResponse,
  buildSoapFault,
  parseSoapAction,
  extractTag,
  escapeXml,
} from '../soap/soap.js';
import { parseDidlObject, readDidlDuration, type ParsedDidlObject } from '../didl/didl.js';
import {
  buildDeviceDescription,
  DEVICE_TYPES,
  SERVICE_TYPES,
  type DeviceIdentity,
} from '../description/deviceDescription.js';
import {
  AV_TRANSPORT_SCPD,
  RENDERING_CONTROL_SCPD,
  CONNECTION_MANAGER_SINK_SCPD,
} from '../description/scpd.js';

export type TransportState =
  | 'STOPPED'
  | 'PLAYING'
  | 'PAUSED_PLAYBACK'
  | 'TRANSITIONING'
  | 'NO_MEDIA_PRESENT';

/**
 * The host's playback backend. A control point casting to this renderer calls
 * SOAP actions; the renderer translates them into these callbacks. The host
 * plays `uri` however it likes (its own engine/output) — the module never
 * decodes audio.
 */
export interface RendererHandler {
  /** A new URI was set (SetAVTransportURI). `metadata` is the parsed DIDL item. */
  onSetUri?(uri: string, metadata: ParsedDidlObject | null): void;
  /** Begin playing the current URI. `startAtSec` set when resuming from a Seek. */
  onPlay(uri: string, startAtSec?: number): void;
  onPause?(): void;
  onResume?(): void;
  onStop?(): void;
  onSeek?(seconds: number): void;
  onVolume?(percent: number): void;
  onMute?(muted: boolean): void;
  /**
   * Current playback position/duration for GetPositionInfo, if the host tracks
   * it. When omitted, the renderer estimates from wall-clock since play started.
   */
  getPosition?(): { elapsed: number; duration: number } | null;
}

export interface UpnpMediaRendererOptions {
  /** Stable per-renderer UDN (uuid:...). */
  udn: string;
  /** Friendly name shown to control points (resolved per call so it can change). */
  friendlyName: () => string;
  /** Absolute base URL for this renderer, e.g. http://ip:7090/dlna-renderer/1 */
  baseUrl: () => string;
  /** Playback backend. */
  handler: RendererHandler;
  identity?: Partial<DeviceIdentity>;
  logger?: UpnpLogger;
}

/** Sub-paths under the renderer base URL. */
export const RENDERER_PATHS = {
  device: 'device.xml',
  avtScpd: 'avt/scpd.xml',
  rcScpd: 'rc/scpd.xml',
  cmScpd: 'cm/scpd.xml',
  avtControl: 'avt/control',
  rcControl: 'rc/control',
  cmControl: 'cm/control',
  avtEvent: 'avt/event',
  rcEvent: 'rc/event',
} as const;

const AVT_NS = SERVICE_TYPES.avTransport;
const RC_NS = SERVICE_TYPES.renderingControl;
const CM_NS = SERVICE_TYPES.connectionManager;
const SINK_PROTOCOL_INFO = [
  'audio/mpeg', 'audio/x-mpeg', 'audio/mp4', 'audio/aac', 'audio/flac',
  'audio/x-flac', 'audio/wav', 'audio/L16', 'application/ogg',
].map((mime) => `http-get:*:${mime}:*`).join(',');

type GenaSubscription = {
  sid: string;
  callbackUrl: string;
  expiresAt: number;
  seq: number;
  service: 'AVTransport' | 'RenderingControl';
};

/**
 * A UPnP MediaRenderer: it accepts SetAVTransportURI + Play from any DLNA control
 * point and drives the host's playback via a small `RendererHandler`. Reports
 * transport state, duration and position via GetTransportInfo/GetPositionInfo and
 * GENA LastChange events, so controlling apps reflect play/pause and a timeline.
 *
 * The host serves device.xml + SCPD + SOAP control by routing HTTP requests under
 * the renderer's base path to `handle(req, res, sub)`; it advertises the device
 * on an SsdpAdvertiser (see deviceTypeAndServices()).
 */
export class UpnpMediaRenderer {
  private transportState: TransportState = 'NO_MEDIA_PRESENT';
  private currentUri = '';
  private currentUriMetaData = '';
  private nextUri = '';
  private nextUriMetaData = '';
  private durationSec = 0;
  private volume = 100;
  private muted = false;
  private startedAtMs = 0;
  private pausedElapsedSec = 0;

  private readonly subscriptions = new Map<string, GenaSubscription>();
  private renewTimer?: ReturnType<typeof setInterval>;
  private readonly log?: UpnpLogger;

  constructor(private readonly opts: UpnpMediaRendererOptions) {
    this.log = opts.logger;
    this.renewTimer = setInterval(() => this.pruneSubscriptions(), 30_000);
    this.renewTimer.unref?.();
  }

  public get udn(): string {
    return this.opts.udn;
  }

  /** The device type + service types for SSDP advertising. */
  public deviceTypeAndServices(): { deviceType: string; serviceTypes: string[] } {
    return {
      deviceType: DEVICE_TYPES.mediaRenderer,
      serviceTypes: [AVT_NS, RC_NS, CM_NS],
    };
  }

  public dispose(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
    this.subscriptions.clear();
  }

  /** Reflect a volume change that happened outside UPnP (host → renderer). */
  public reflectVolume(percent: number): void {
    this.volume = clampVolume(percent);
  }

  /** Reflect a transport-state change that happened outside UPnP. */
  public reflectTransportState(state: TransportState): void {
    this.setState(state);
  }

  // ── HTTP handling ───────────────────────────────────────────────────────────

  /** `sub` is the path AFTER the renderer base, e.g. 'avt/control'. */
  public async handle(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      if (sub === RENDERER_PATHS.device) {
        return this.sendXml(res, this.deviceXml());
      }
      if (sub === RENDERER_PATHS.avtScpd) {
        return this.sendXml(res, AV_TRANSPORT_SCPD);
      }
      if (sub === RENDERER_PATHS.rcScpd) {
        return this.sendXml(res, RENDERING_CONTROL_SCPD);
      }
      if (sub === RENDERER_PATHS.cmScpd) {
        return this.sendXml(res, CONNECTION_MANAGER_SINK_SCPD);
      }
      return this.notFound(res);
    }

    if (method === 'SUBSCRIBE' || method === 'UNSUBSCRIBE') {
      return this.handleGena(req, res, sub, method);
    }

    if (method === 'POST') {
      if (sub === RENDERER_PATHS.avtControl) return this.handleAvtControl(req, res);
      if (sub === RENDERER_PATHS.rcControl) return this.handleRcControl(req, res);
      if (sub === RENDERER_PATHS.cmControl) return this.handleCmControl(req, res);
      return this.notFound(res);
    }
    return this.notFound(res);
  }

  private deviceXml(): string {
    const base = this.opts.baseUrl();
    const svc = (name: keyof typeof RENDERER_PATHS) => `${base}/${RENDERER_PATHS[name]}`;
    return buildDeviceDescription({
      deviceType: DEVICE_TYPES.mediaRenderer,
      dlnaDoc: 'DMR-1.50',
      identity: {
        udn: this.opts.udn,
        friendlyName: this.opts.friendlyName(),
        ...this.opts.identity,
      },
      services: [
        {
          serviceType: AVT_NS,
          serviceId: 'urn:upnp-org:serviceId:AVTransport',
          scpdUrl: svc('avtScpd'),
          controlUrl: svc('avtControl'),
          eventSubUrl: svc('avtEvent'),
        },
        {
          serviceType: RC_NS,
          serviceId: 'urn:upnp-org:serviceId:RenderingControl',
          scpdUrl: svc('rcScpd'),
          controlUrl: svc('rcControl'),
          eventSubUrl: svc('rcEvent'),
        },
        {
          serviceType: CM_NS,
          serviceId: 'urn:upnp-org:serviceId:ConnectionManager',
          scpdUrl: svc('cmScpd'),
          controlUrl: svc('cmControl'),
          eventSubUrl: `${base}/cm/event`,
        },
      ],
    });
  }

  // ── AVTransport SOAP ────────────────────────────────────────────────────────

  private async handleAvtControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = parseSoapAction(req.headers['soapaction']);
    const body = await readBody(req);
    try {
      switch (action) {
        case 'SetAVTransportURI':
          return this.actSetUri(res, body);
        case 'SetNextAVTransportURI':
          return this.actSetNextUri(res, body);
        case 'Play':
          return this.actPlay(res);
        case 'Pause':
          return this.actPause(res);
        case 'Stop':
          return this.actStop(res);
        case 'Seek':
          return this.actSeek(res, body);
        case 'GetTransportInfo':
          return this.actGetTransportInfo(res);
        case 'GetPositionInfo':
          return this.actGetPositionInfo(res);
        case 'GetMediaInfo':
          return this.actGetMediaInfo(res);
        case 'GetTransportSettings':
          return this.sendSoap(res, AVT_NS, 'GetTransportSettings', {
            PlayMode: 'NORMAL',
            RecQualityMode: 'NOT_IMPLEMENTED',
          });
        case 'GetDeviceCapabilities':
          return this.sendSoap(res, AVT_NS, 'GetDeviceCapabilities', {
            PlayMedia: 'NETWORK,HDD',
            RecMedia: 'NOT_IMPLEMENTED',
            RecQualityModes: 'NOT_IMPLEMENTED',
          });
        default:
          return this.sendFault(res, 'Unsupported action');
      }
    } catch (error) {
      this.log?.warn?.('avt control failed', {
        action,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.sendFault(res, 'Action failed');
    }
  }

  private actSetUri(res: ServerResponse, body: string): void {
    const uri = extractTag(body, 'CurrentURI') ?? '';
    const meta = extractTag(body, 'CurrentURIMetaData') ?? '';
    this.currentUri = uri;
    this.currentUriMetaData = meta;
    this.durationSec = parseClock(readDidlDuration(meta) ?? '') ?? 0;
    this.pausedElapsedSec = 0;
    this.setState(uri ? 'STOPPED' : 'NO_MEDIA_PRESENT');
    this.opts.handler.onSetUri?.(uri, meta ? parseDidlObject(meta) : null);
    this.sendSoap(res, AVT_NS, 'SetAVTransportURI', {});
  }

  private actSetNextUri(res: ServerResponse, body: string): void {
    this.nextUri = extractTag(body, 'NextURI') ?? '';
    this.nextUriMetaData = extractTag(body, 'NextURIMetaData') ?? '';
    this.sendSoap(res, AVT_NS, 'SetNextAVTransportURI', {});
  }

  private actPlay(res: ServerResponse): void {
    if (!this.currentUri) {
      return this.sendFault(res, 'No media', 701);
    }
    if (this.transportState === 'PAUSED_PLAYBACK') {
      this.opts.handler.onResume?.();
      this.startedAtMs = Date.now() - this.pausedElapsedSec * 1000;
      this.setState('PLAYING');
      return this.sendSoap(res, AVT_NS, 'Play', {});
    }
    this.startedAtMs = Date.now();
    this.pausedElapsedSec = 0;
    this.opts.handler.onPlay(this.currentUri);
    this.setState('PLAYING');
    this.sendSoap(res, AVT_NS, 'Play', {});
  }

  private actPause(res: ServerResponse): void {
    this.opts.handler.onPause?.();
    this.pausedElapsedSec = this.elapsedSec();
    this.setState('PAUSED_PLAYBACK');
    this.sendSoap(res, AVT_NS, 'Pause', {});
  }

  private actStop(res: ServerResponse): void {
    this.opts.handler.onStop?.();
    this.pausedElapsedSec = 0;
    this.setState('STOPPED');
    this.sendSoap(res, AVT_NS, 'Stop', {});
  }

  private actSeek(res: ServerResponse, body: string): void {
    const unit = extractTag(body, 'Unit') ?? '';
    const target = extractTag(body, 'Target') ?? '';
    if (unit === 'REL_TIME') {
      const seconds = parseClock(target);
      if (seconds !== null && this.currentUri) {
        this.opts.handler.onSeek?.(seconds);
        this.opts.handler.onPlay(this.currentUri, seconds);
        this.startedAtMs = Date.now() - seconds * 1000;
        this.pausedElapsedSec = 0;
        this.setState('PLAYING');
      }
    }
    this.sendSoap(res, AVT_NS, 'Seek', {});
  }

  private actGetTransportInfo(res: ServerResponse): void {
    this.sendSoap(res, AVT_NS, 'GetTransportInfo', {
      CurrentTransportState: this.transportState,
      CurrentTransportStatus: 'OK',
      CurrentSpeed: '1',
    });
  }

  private actGetPositionInfo(res: ServerResponse): void {
    const pos = this.opts.handler.getPosition?.();
    const elapsed = pos ? pos.elapsed : this.elapsedSec();
    const duration = pos ? pos.duration : this.durationSec;
    const rel = formatClock(elapsed);
    this.sendSoap(res, AVT_NS, 'GetPositionInfo', {
      Track: '1',
      TrackDuration: formatClock(duration),
      TrackMetaData: this.currentUriMetaData,
      TrackURI: this.currentUri,
      RelTime: rel,
      AbsTime: rel,
      RelCount: '2147483647',
      AbsCount: '2147483647',
    });
  }

  private actGetMediaInfo(res: ServerResponse): void {
    this.sendSoap(res, AVT_NS, 'GetMediaInfo', {
      NrTracks: this.currentUri ? '1' : '0',
      MediaDuration: formatClock(this.durationSec),
      CurrentURI: this.currentUri,
      CurrentURIMetaData: this.currentUriMetaData,
      NextURI: this.nextUri,
      NextURIMetaData: this.nextUriMetaData,
      PlayMedium: this.currentUri ? 'NETWORK' : 'NONE',
      RecordMedium: 'NOT_IMPLEMENTED',
      WriteStatus: 'NOT_IMPLEMENTED',
    });
  }

  // ── RenderingControl SOAP ───────────────────────────────────────────────────

  private async handleRcControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = parseSoapAction(req.headers['soapaction']);
    const body = await readBody(req);
    switch (action) {
      case 'GetVolume':
        return this.sendSoap(res, RC_NS, 'GetVolume', { CurrentVolume: String(this.volume) });
      case 'SetVolume': {
        const desired = Number(extractTag(body, 'DesiredVolume') ?? '');
        if (Number.isFinite(desired)) {
          this.volume = clampVolume(desired);
          this.opts.handler.onVolume?.(this.volume);
        }
        return this.sendSoap(res, RC_NS, 'SetVolume', {});
      }
      case 'GetMute':
        return this.sendSoap(res, RC_NS, 'GetMute', { CurrentMute: this.muted ? '1' : '0' });
      case 'SetMute': {
        const desired = (extractTag(body, 'DesiredMute') ?? '').trim();
        this.muted = desired === '1' || desired.toLowerCase() === 'true';
        this.opts.handler.onMute?.(this.muted);
        return this.sendSoap(res, RC_NS, 'SetMute', {});
      }
      default:
        return this.sendFault(res, 'Unsupported action');
    }
  }

  private async handleCmControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = parseSoapAction(req.headers['soapaction']);
    await readBody(req);
    if (action === 'GetProtocolInfo') {
      return this.sendSoap(res, CM_NS, 'GetProtocolInfo', {
        Source: '',
        Sink: SINK_PROTOCOL_INFO,
      });
    }
    return this.sendFault(res, 'Unsupported action');
  }

  // ── GENA eventing ───────────────────────────────────────────────────────────

  private async handleGena(
    req: IncomingMessage,
    res: ServerResponse,
    sub: string,
    method: string,
  ): Promise<void> {
    const service = sub === RENDERER_PATHS.avtEvent
      ? 'AVTransport'
      : sub === RENDERER_PATHS.rcEvent
        ? 'RenderingControl'
        : null;
    if (!service) {
      return this.notFound(res);
    }
    if (method === 'UNSUBSCRIBE') {
      const sid = String(req.headers['sid'] ?? '');
      this.subscriptions.delete(sid);
      res.writeHead(200);
      res.end();
      return;
    }
    const existingSid = String(req.headers['sid'] ?? '');
    const timeout = 1800;
    if (existingSid && this.subscriptions.has(existingSid)) {
      const s = this.subscriptions.get(existingSid)!;
      s.expiresAt = Date.now() + timeout * 1000;
      res.writeHead(200, { SID: existingSid, TIMEOUT: `Second-${timeout}` });
      res.end();
      return;
    }
    const callbackUrl = firstCallback(String(req.headers['callback'] ?? ''));
    const sid = `uuid:${this.opts.udn.slice(5)}-${service}-${this.subscriptions.size + 1}`;
    if (callbackUrl) {
      this.subscriptions.set(sid, {
        sid,
        callbackUrl,
        expiresAt: Date.now() + timeout * 1000,
        seq: 0,
        service,
      });
    }
    res.writeHead(200, { SID: sid, TIMEOUT: `Second-${timeout}` });
    res.end();
    if (callbackUrl) {
      this.notifySubscriber(this.subscriptions.get(sid)!);
    }
  }

  private setState(state: TransportState): void {
    if (this.transportState === state) {
      return;
    }
    this.transportState = state;
    for (const s of this.subscriptions.values()) {
      if (s.service === 'AVTransport') {
        this.notifySubscriber(s);
      }
    }
  }

  private buildAvtLastChange(): string {
    const inner =
      `<TransportState val="${escapeXml(this.transportState)}"/>` +
      `<CurrentTrackURI val="${escapeXml(this.currentUri)}"/>` +
      `<CurrentTrackDuration val="${escapeXml(formatClock(this.durationSec))}"/>` +
      `<CurrentTrackMetaData val="${escapeXml(this.currentUriMetaData)}"/>` +
      `<AVTransportURI val="${escapeXml(this.currentUri)}"/>`;
    return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">${inner}</InstanceID></Event>`;
  }

  private buildRcLastChange(): string {
    const inner =
      `<Volume channel="Master" val="${this.volume}"/>` +
      `<Mute channel="Master" val="${this.muted ? 1 : 0}"/>`;
    return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">${inner}</InstanceID></Event>`;
  }

  private notifySubscriber(sub: GenaSubscription): void {
    const lastChange = sub.service === 'AVTransport'
      ? this.buildAvtLastChange()
      : this.buildRcLastChange();
    const propertyset =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
      `<e:property><LastChange>${escapeXml(lastChange)}</LastChange></e:property>` +
      '</e:propertyset>';
    let url: URL;
    try {
      url = new URL(sub.callbackUrl);
    } catch {
      return;
    }
    const seq = sub.seq;
    sub.seq += 1;
    const reqOptions: http.RequestOptions = {
      method: 'NOTIFY',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        NT: 'upnp:event',
        NTS: 'upnp:propchange',
        SID: sub.sid,
        SEQ: String(seq),
        'Content-Length': Buffer.byteLength(propertyset),
      },
    };
    const clientReq = http.request(reqOptions, (r) => r.resume());
    clientReq.on('error', () => { /* subscriber gone; pruned on expiry */ });
    clientReq.end(propertyset);
  }

  private pruneSubscriptions(): void {
    const now = Date.now();
    for (const [sid, s] of this.subscriptions) {
      if (s.expiresAt <= now) {
        this.subscriptions.delete(sid);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private elapsedSec(): number {
    if (this.transportState === 'PAUSED_PLAYBACK') {
      return this.pausedElapsedSec;
    }
    if (this.transportState !== 'PLAYING' || !this.startedAtMs) {
      return 0;
    }
    const e = Math.floor((Date.now() - this.startedAtMs) / 1000);
    return this.durationSec > 0 ? Math.min(e, this.durationSec) : e;
  }

  private sendXml(res: ServerResponse, xml: string): void {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Cache-Control': 'no-cache' });
    res.end(xml);
  }

  private sendSoap(res: ServerResponse, ns: string, action: string, args: Record<string, string>): void {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '' });
    res.end(buildSoapResponse(ns, action, args));
  }

  private sendFault(res: ServerResponse, message: string, code = 401): void {
    res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
    res.end(buildSoapFault(message, code));
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not-found');
  }
}

function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function firstCallback(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return m?.[1] ?? header.trim();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const MAX = 512 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) return;
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseClock(value: string): number | null {
  const t = value.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.round(sec);
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(sec)}`;
}
