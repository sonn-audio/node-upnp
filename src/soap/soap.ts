/**
 * Minimal SOAP helpers for UPnP control (AVTransport / RenderingControl /
 * ContentDirectory / ConnectionManager). UPnP uses a tiny, regular subset of
 * SOAP, so we parse and build it with string/regex operations rather than a full
 * XML stack — matching how real devices are lenient about namespaces.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Extract the bare action name from a SOAPACTION header value. */
export function parseSoapAction(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  const cleaned = raw.replace(/"/g, '').trim();
  const hash = cleaned.lastIndexOf('#');
  return hash >= 0 ? cleaned.slice(hash + 1) : cleaned;
}

/**
 * Extract a (possibly namespaced) tag's inner text and SOAP-unescape it.
 * Matches `<Tag>…</Tag>` or `<u:Tag …>…</u:Tag>` — namespace-tolerant.
 */
export function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const match = re.exec(xml);
  if (!match) {
    return null;
  }
  return unescapeXml(match[1] ?? '').trim();
}

/** Build a SOAP action-response envelope with the given out-arguments. */
export function buildSoapResponse(
  serviceType: string,
  action: string,
  args: Record<string, string> = {},
): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action}Response xmlns:u="${serviceType}">${body}</u:${action}Response>` +
    '</s:Body></s:Envelope>'
  );
}

/**
 * Build a SOAP action-request envelope. `args` values are inserted as-is, so a
 * caller passing DIDL metadata must pass it already XML-escaped (matching how
 * SetAVTransportURI carries an escaped DIDL string in CurrentURIMetaData).
 */
export function buildSoapRequest(
  serviceType: string,
  action: string,
  args: Record<string, string> = {},
): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}"><InstanceID>0</InstanceID>${body}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

/** UPnP-style SOAP fault envelope with a UPnPError detail. */
export function buildSoapFault(message: string, errorCode = 401): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><s:Fault><faultcode>s:Client</faultcode>' +
    '<faultstring>UPnPError</faultstring><detail>' +
    `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${errorCode}</errorCode>` +
    `<errorDescription>${escapeXml(message)}</errorDescription></UPnPError>` +
    '</detail></s:Fault></s:Body></s:Envelope>'
  );
}

/** Extract the SOAP fault errorCode from a device response, if present. */
export function extractFaultCode(xml: string): string | null {
  return /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(xml)?.[1] ?? null;
}
