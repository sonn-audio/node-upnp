import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UpnpLogger } from '../logger.js';
import {
  parseSoapAction,
  extractTag,
  buildSoapResponse,
  buildSoapFault,
  escapeXml,
} from '../soap/soap.js';
import {
  buildContainerElement,
  buildItemElement,
  wrapDidl,
  type DidlContainer,
  type DidlItem,
} from '../didl/didl.js';
import {
  buildDeviceDescription,
  DEVICE_TYPES,
  SERVICE_TYPES,
  type DeviceIdentity,
} from '../description/deviceDescription.js';
import {
  CONTENT_DIRECTORY_SCPD,
  CONNECTION_MANAGER_SCPD,
} from '../description/scpd.js';

/** The root container object id per the UPnP ContentDirectory spec. */
export const ROOT_OBJECT_ID = '0';

export type BrowseFlag = 'BrowseMetadata' | 'BrowseDirectChildren';

export interface BrowseRequest {
  objectId: string;
  browseFlag: BrowseFlag;
  startingIndex: number;
  requestedCount: number;
  filter?: string;
  sortCriteria?: string;
}

export interface BrowseResult {
  /** Container/item shapes to serialise (module builds the DIDL). */
  objects: Array<DidlContainer | DidlItem>;
  /** Total matches (for paging); defaults to objects.length. */
  total?: number;
}

export interface SearchRequest {
  /** Container to search within; ROOT_OBJECT_ID means "the whole server". */
  containerId: string;
  /** The raw UPnP SearchCriteria expression (parse with {@link parseSearchCriteria}). */
  searchCriteria: string;
  startingIndex: number;
  requestedCount: number;
  filter?: string;
  sortCriteria?: string;
}

/**
 * The host's content backend. The MediaServer answers UPnP Browse (and, when
 * implemented, Search) by delegating to this — the host maps its own catalogue
 * onto neutral DIDL shapes, so the module never depends on the app's content
 * model.
 */
export interface ContentProvider {
  /** BrowseDirectChildren of a container (ROOT_OBJECT_ID for the top level). */
  browse(objectId: string, startingIndex: number, requestedCount: number): Promise<BrowseResult>;
  /** BrowseMetadata of a single object (optional; return null if unsupported). */
  browseMetadata?(objectId: string): Promise<DidlContainer | DidlItem | null>;
  /**
   * Search within a container. Optional: when omitted the server advertises empty
   * SearchCapabilities (the spec signal that tells control points not to search).
   * The host parses `searchCriteria` (see {@link parseSearchCriteria}) and returns
   * matching objects as neutral DIDL shapes.
   */
  search?(
    containerId: string,
    searchCriteria: string,
    startingIndex: number,
    requestedCount: number,
  ): Promise<BrowseResult>;
}

export interface UpnpMediaServerOptions {
  udn: string;
  friendlyName: () => string;
  baseUrl: () => string;
  provider: ContentProvider;
  /** ConnectionManager source protocolInfo (what this server serves). */
  sourceProtocolInfo?: string;
  /**
   * The searchable properties advertised in GetSearchCapabilities, e.g.
   * `'dc:title,upnp:artist,upnp:album'` or `'*'`. Only advertised when the
   * provider implements `search()`; omit for no search.
   */
  searchCapabilities?: string;
  identity?: Partial<DeviceIdentity>;
  logger?: UpnpLogger;
}

const CDS_NS = SERVICE_TYPES.contentDirectory;
const CMS_NS = SERVICE_TYPES.connectionManager;

/** Sub-paths under the media-server base URL. */
export const MEDIA_SERVER_PATHS = {
  device: 'device.xml',
  cdsScpd: 'cds/scpd.xml',
  cmsScpd: 'cms/scpd.xml',
  cdsControl: 'cds/control',
  cmsControl: 'cms/control',
  cdsEvent: 'cds/event',
  cmsEvent: 'cms/event',
} as const;

/**
 * A UPnP MediaServer: advertises a ContentDirectory + ConnectionManager and
 * answers Browse over a host-supplied `ContentProvider`. Serves device.xml, SCPD
 * and SOAP control under a base path via `handle(req, res, sub)`. Advertise the
 * device on an SsdpAdvertiser using `deviceTypeAndServices()`.
 */
export class UpnpMediaServer {
  private readonly log?: UpnpLogger;

  constructor(private readonly opts: UpnpMediaServerOptions) {
    this.log = opts.logger;
  }

  public get udn(): string {
    return this.opts.udn;
  }

  public deviceTypeAndServices(): { deviceType: string; serviceTypes: string[] } {
    return { deviceType: DEVICE_TYPES.mediaServer, serviceTypes: [CDS_NS, CMS_NS] };
  }

  /** `sub` is the path AFTER the media-server base, e.g. 'cds/control'. */
  public async handle(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      if (sub === MEDIA_SERVER_PATHS.device) return this.sendXml(res, this.deviceXml());
      if (sub === MEDIA_SERVER_PATHS.cdsScpd) return this.sendXml(res, CONTENT_DIRECTORY_SCPD);
      if (sub === MEDIA_SERVER_PATHS.cmsScpd) return this.sendXml(res, CONNECTION_MANAGER_SCPD);
      return this.notFound(res);
    }
    if (method === 'SUBSCRIBE' || method === 'UNSUBSCRIBE') {
      // Content tree is effectively static per session; accept a silent subscription.
      res.writeHead(200, {
        SID: `uuid:${this.opts.udn.slice(5)}-cds`,
        TIMEOUT: 'Second-1800',
      });
      res.end();
      return;
    }
    if (method === 'POST') {
      if (sub === MEDIA_SERVER_PATHS.cdsControl) return this.handleCdsControl(req, res);
      if (sub === MEDIA_SERVER_PATHS.cmsControl) return this.handleCmsControl(req, res);
      return this.notFound(res);
    }
    return this.notFound(res);
  }

  private deviceXml(): string {
    const base = this.opts.baseUrl();
    const p = (name: keyof typeof MEDIA_SERVER_PATHS) => `${base}/${MEDIA_SERVER_PATHS[name]}`;
    return buildDeviceDescription({
      deviceType: DEVICE_TYPES.mediaServer,
      dlnaDoc: 'DMS-1.50',
      identity: {
        udn: this.opts.udn,
        friendlyName: this.opts.friendlyName(),
        ...this.opts.identity,
      },
      services: [
        {
          serviceType: CDS_NS,
          serviceId: 'urn:upnp-org:serviceId:ContentDirectory',
          scpdUrl: p('cdsScpd'),
          controlUrl: p('cdsControl'),
          eventSubUrl: p('cdsEvent'),
        },
        {
          serviceType: CMS_NS,
          serviceId: 'urn:upnp-org:serviceId:ConnectionManager',
          scpdUrl: p('cmsScpd'),
          controlUrl: p('cmsControl'),
          eventSubUrl: p('cmsEvent'),
        },
      ],
    });
  }

  // ── ContentDirectory SOAP ─────────────────────────────────────────────────

  private async handleCdsControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      return this.methodNotAllowed(res);
    }
    const action = parseSoapAction(req.headers['soapaction']);
    const body = await readBody(req);
    if (action === 'Browse' || /<[\w:]*Browse[\s>]/.test(body)) {
      const parsed = this.parseBrowse(body);
      if (!parsed) {
        return this.sendSoapRaw(res, buildSoapFault('Invalid Browse request'), 500);
      }
      try {
        const result = await this.browse(parsed);
        return this.sendSoapRaw(res, this.buildDirectoryResponse('Browse', result));
      } catch (error) {
        this.log?.warn?.('browse failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        return this.sendSoapRaw(res, buildSoapFault('Browse failed'), 500);
      }
    }
    if (action === 'Search' || /<[\w:]*Search[\s>]/.test(body)) {
      if (!this.opts.provider.search) {
        return this.sendSoapRaw(res, buildSoapFault('Search not supported'), 500);
      }
      const parsed = this.parseSearch(body);
      if (!parsed) {
        return this.sendSoapRaw(res, buildSoapFault('Invalid Search request'), 500);
      }
      try {
        const result = await this.search(parsed);
        return this.sendSoapRaw(res, this.buildDirectoryResponse('Search', result));
      } catch (error) {
        this.log?.warn?.('search failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        return this.sendSoapRaw(res, buildSoapFault('Search failed'), 500);
      }
    }
    if (/GetSystemUpdateID/.test(action) || /GetSystemUpdateID/.test(body)) {
      return this.sendSoap(res, CDS_NS, 'GetSystemUpdateID', { Id: '1' });
    }
    if (/GetSearchCapabilities/.test(action) || /GetSearchCapabilities/.test(body)) {
      // Only advertise capabilities when the provider can actually search; empty
      // is the spec signal that tells control points not to issue Search.
      const caps = this.opts.provider.search ? this.opts.searchCapabilities ?? '' : '';
      return this.sendSoap(res, CDS_NS, 'GetSearchCapabilities', { SearchCaps: caps });
    }
    if (/GetSortCapabilities/.test(action) || /GetSortCapabilities/.test(body)) {
      return this.sendSoap(res, CDS_NS, 'GetSortCapabilities', { SortCaps: '' });
    }
    return this.sendSoapRaw(res, buildSoapFault('Unsupported action'), 500);
  }

  private parseBrowse(body: string): BrowseRequest | null {
    if (!/<[\w:]*Browse[\s>]/.test(body)) {
      return null;
    }
    const objectId = extractTag(body, 'ObjectID') ?? ROOT_OBJECT_ID;
    const flagRaw = extractTag(body, 'BrowseFlag') ?? 'BrowseDirectChildren';
    const browseFlag: BrowseFlag =
      flagRaw === 'BrowseMetadata' ? 'BrowseMetadata' : 'BrowseDirectChildren';
    const startingIndex = toInt(extractTag(body, 'StartingIndex'), 0);
    const requestedCount = toInt(extractTag(body, 'RequestedCount'), 0);
    return { objectId, browseFlag, startingIndex, requestedCount };
  }

  private parseSearch(body: string): SearchRequest | null {
    if (!/<[\w:]*Search[\s>]/.test(body)) {
      return null;
    }
    const containerId = extractTag(body, 'ContainerID') ?? ROOT_OBJECT_ID;
    const searchCriteria = extractTag(body, 'SearchCriteria') ?? '';
    const startingIndex = toInt(extractTag(body, 'StartingIndex'), 0);
    const requestedCount = toInt(extractTag(body, 'RequestedCount'), 0);
    return { containerId, searchCriteria, startingIndex, requestedCount };
  }

  private async search(req: SearchRequest): Promise<{ didl: string; numberReturned: number; totalMatches: number }> {
    // RequestedCount 0 means "all" in UPnP; cap to a sane page.
    const limit = req.requestedCount > 0 ? req.requestedCount : 200;
    const offset = req.startingIndex > 0 ? req.startingIndex : 0;
    const result = await this.opts.provider.search!(req.containerId, req.searchCriteria, offset, limit);
    const elements = result.objects.map((o) =>
      isItem(o) ? buildItemElement(o) : buildContainerElement(o),
    );
    const total = typeof result.total === 'number' && result.total > 0
      ? result.total
      : offset + elements.length;
    return { didl: wrapDidl(elements), numberReturned: elements.length, totalMatches: total };
  }

  private async browse(req: BrowseRequest): Promise<{ didl: string; numberReturned: number; totalMatches: number }> {
    if (req.browseFlag === 'BrowseMetadata') {
      const obj = this.opts.provider.browseMetadata
        ? await this.opts.provider.browseMetadata(req.objectId)
        : null;
      if (!obj) {
        return { didl: wrapDidl([]), numberReturned: 0, totalMatches: 0 };
      }
      const el = isItem(obj) ? buildItemElement(obj) : buildContainerElement(obj);
      return { didl: wrapDidl([el]), numberReturned: 1, totalMatches: 1 };
    }
    // RequestedCount 0 means "all" in UPnP; cap to a sane page.
    const limit = req.requestedCount > 0 ? req.requestedCount : 200;
    const offset = req.startingIndex > 0 ? req.startingIndex : 0;
    const result = await this.opts.provider.browse(req.objectId, offset, limit);
    const elements = result.objects.map((o) =>
      isItem(o) ? buildItemElement(o) : buildContainerElement(o),
    );
    const total = typeof result.total === 'number' && result.total > 0
      ? result.total
      : offset + elements.length;
    return { didl: wrapDidl(elements), numberReturned: elements.length, totalMatches: total };
  }

  /** Build a Browse/Search SOAP response (identical shape, different action name). */
  private buildDirectoryResponse(
    action: 'Browse' | 'Search',
    result: { didl: string; numberReturned: number; totalMatches: number },
    updateId = 0,
  ): string {
    const escapedDidl = escapeXml(result.didl);
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:${action}Response xmlns:u="${CDS_NS}">` +
      `<Result>${escapedDidl}</Result>` +
      `<NumberReturned>${result.numberReturned}</NumberReturned>` +
      `<TotalMatches>${result.totalMatches}</TotalMatches>` +
      `<UpdateID>${updateId}</UpdateID>` +
      `</u:${action}Response>` +
      '</s:Body></s:Envelope>'
    );
  }

  private async handleCmsControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = parseSoapAction(req.headers['soapaction']);
    await readBody(req);
    if (action === 'GetProtocolInfo') {
      return this.sendSoap(res, CMS_NS, 'GetProtocolInfo', {
        Source: this.opts.sourceProtocolInfo ?? 'http-get:*:audio/mpeg:*',
        Sink: '',
      });
    }
    return this.sendSoapRaw(res, buildSoapFault('Unsupported action'), 500);
  }

  private sendXml(res: ServerResponse, xml: string): void {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Cache-Control': 'no-cache' });
    res.end(xml);
  }

  private sendSoap(res: ServerResponse, ns: string, action: string, args: Record<string, string>): void {
    this.sendSoapRaw(res, buildSoapResponse(ns, action, args));
  }

  private sendSoapRaw(res: ServerResponse, xml: string, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '' });
    res.end(xml);
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not-found');
  }

  private methodNotAllowed(res: ServerResponse): void {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method-not-allowed');
  }
}

/**
 * Decide whether a provider-supplied object is a playable item or a browsable
 * container. A container is identified by its `upnp:class` (object.container.*)
 * or a `childCount`; everything else serialises as an item. Providers that build
 * containers should set `upnpClass` to a `object.container.*` value (the default
 * in {@link buildContainerElement}) so this stays unambiguous.
 */
/** A parsed UPnP SearchCriteria expression, in the shape a provider needs. */
export interface ParsedSearchCriteria {
  /** Free-text search terms extracted from the criteria (deduped). */
  terms: string[];
  /** Restrict to only playable items or only browsable containers, if the criteria says so. */
  classFilter: 'item' | 'container' | null;
  /** True when the criteria is the wildcard `*` (match everything). */
  matchAll: boolean;
}

/**
 * Parse a UPnP `SearchCriteria` expression into a host-friendly shape. The full
 * grammar is a boolean expression over properties; in practice control points send
 * a small set of shapes, so this extracts what a content backend actually needs:
 * the free-text term(s) from `contains`/`=` clauses on text properties, and a
 * coarse item-vs-container class restriction from `upnp:class derivedfrom "…"`.
 *
 * Examples it handles:
 *   `dc:title contains "beatles"`
 *   `(upnp:class derivedfrom "object.item.audioItem") and (dc:title contains "x")`
 *   `upnp:artist contains "foo" or dc:title contains "foo"`
 *   `*`  → matchAll
 */
export function parseSearchCriteria(criteria: string): ParsedSearchCriteria {
  const raw = (criteria ?? '').trim();
  if (raw === '' || raw === '*') {
    return { terms: [], classFilter: null, matchAll: raw === '*' };
  }
  // Coarse class restriction from upnp:class derivedfrom / = "object.item…|object.container…".
  const classes = [...raw.matchAll(/upnp:class\s+(?:derivedfrom|=)\s+"([^"]+)"/gi)].map(
    (m) => (m[1] ?? '').toLowerCase(),
  );
  const wantsItem = classes.some((c) => c.startsWith('object.item'));
  const wantsContainer = classes.some((c) => c.startsWith('object.container'));
  let classFilter: 'item' | 'container' | null = null;
  if (wantsItem && !wantsContainer) {
    classFilter = 'item';
  } else if (wantsContainer && !wantsItem) {
    classFilter = 'container';
  }
  // Free-text terms from contains/= on the common text properties.
  const terms: string[] = [];
  const add = (term: string): void => {
    const t = term.trim();
    if (t && !terms.some((x) => x.toLowerCase() === t.toLowerCase())) {
      terms.push(t);
    }
  };
  const re = /(?:dc:title|upnp:artist|upnp:album|dc:creator|upnp:genre)\s+(?:contains|=)\s+"([^"]*)"/gi;
  for (const m of raw.matchAll(re)) {
    add(m[1] ?? '');
  }
  // Fallback: first quoted value that isn't a upnp:class token.
  if (terms.length === 0) {
    for (const m of raw.matchAll(/"([^"]+)"/g)) {
      const v = (m[1] ?? '').trim();
      if (v && !v.toLowerCase().startsWith('object.')) {
        add(v);
        break;
      }
    }
  }
  return { terms, classFilter, matchAll: false };
}

function isItem(o: DidlContainer | DidlItem): o is DidlItem {
  const cls = (o.upnpClass ?? '').toLowerCase();
  if (cls.startsWith('object.container')) {
    return false;
  }
  if (cls.startsWith('object.item')) {
    return true;
  }
  if ((o as DidlContainer).childCount !== undefined) {
    return false;
  }
  // No class hint and no childCount: treat as an item only if it carries item-only
  // fields (resources/artist/album); otherwise assume a bare container.
  const item = o as DidlItem;
  return item.resources !== undefined || item.artist !== undefined || item.album !== undefined;
}

function toInt(value: string | null, fallback: number): number {
  const n = Number((value ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const MAX = 256 * 1024;
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
