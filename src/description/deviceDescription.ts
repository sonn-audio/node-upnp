import { escapeXml } from '../soap/soap.js';

/**
 * UPnP device-description (device.xml) builders, parameterized so a host app sets
 * its own manufacturer/model/friendly name. One builder per device type we
 * support: MediaServer and MediaRenderer. Service SCPD documents live in
 * ./scpd.ts.
 */

export interface DeviceIdentity {
  udn: string; // uuid:...
  friendlyName: string;
  manufacturer?: string;
  manufacturerUrl?: string;
  modelName?: string;
  modelNumber?: string;
  modelDescription?: string;
}

export interface ServiceRef {
  serviceType: string; // urn:schemas-upnp-org:service:AVTransport:1
  serviceId: string; // urn:upnp-org:serviceId:AVTransport
  scpdUrl: string;
  controlUrl: string;
  eventSubUrl: string;
}

const DEFAULTS = {
  manufacturer: 'node-upnp',
  manufacturerUrl: 'https://www.npmjs.com/package/@sonn-audio/node-upnp',
  modelName: 'node-upnp',
  modelNumber: '1',
  modelDescription: 'node-upnp device',
};

/** Build a root device description for a given device type + services + DLNA doc. */
export function buildDeviceDescription(params: {
  deviceType: string; // urn:schemas-upnp-org:device:MediaServer:1
  identity: DeviceIdentity;
  services: ServiceRef[];
  /** Optional URLBase; when set, SCPD/control/event URLs may be relative to it. */
  urlBase?: string;
  /** Optional dlna:X_DLNADOC value, e.g. 'DMS-1.50' or 'DMR-1.50'. */
  dlnaDoc?: string;
}): string {
  const { deviceType, identity, services, urlBase, dlnaDoc } = params;
  const id = { ...DEFAULTS, ...identity };
  const urlBaseEl = urlBase ? `<URLBase>${escapeXml(urlBase)}</URLBase>` : '';
  const dlnaEl = dlnaDoc
    ? `<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">${escapeXml(dlnaDoc)}</dlna:X_DLNADOC>`
    : '';
  const serviceList = services.map(serviceElement).join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    urlBaseEl +
    '<device>' +
    `<deviceType>${escapeXml(deviceType)}</deviceType>` +
    `<friendlyName>${escapeXml(id.friendlyName)}</friendlyName>` +
    `<manufacturer>${escapeXml(id.manufacturer)}</manufacturer>` +
    `<manufacturerURL>${escapeXml(id.manufacturerUrl)}</manufacturerURL>` +
    `<modelDescription>${escapeXml(id.modelDescription)}</modelDescription>` +
    `<modelName>${escapeXml(id.modelName)}</modelName>` +
    `<modelNumber>${escapeXml(id.modelNumber)}</modelNumber>` +
    `<UDN>${escapeXml(id.udn)}</UDN>` +
    dlnaEl +
    `<serviceList>${serviceList}</serviceList>` +
    '</device>' +
    '</root>'
  );
}

function serviceElement(s: ServiceRef): string {
  return (
    '<service>' +
    `<serviceType>${escapeXml(s.serviceType)}</serviceType>` +
    `<serviceId>${escapeXml(s.serviceId)}</serviceId>` +
    `<SCPDURL>${escapeXml(s.scpdUrl)}</SCPDURL>` +
    `<controlURL>${escapeXml(s.controlUrl)}</controlURL>` +
    `<eventSubURL>${escapeXml(s.eventSubUrl)}</eventSubURL>` +
    '</service>'
  );
}

// Standard service type / id URNs for convenience.
export const SERVICE_TYPES = {
  contentDirectory: 'urn:schemas-upnp-org:service:ContentDirectory:1',
  connectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
  avTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  renderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
} as const;

export const DEVICE_TYPES = {
  mediaServer: 'urn:schemas-upnp-org:device:MediaServer:1',
  mediaRenderer: 'urn:schemas-upnp-org:device:MediaRenderer:1',
} as const;
