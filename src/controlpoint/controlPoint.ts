import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import type { UpnpLogger } from '../logger.js';
import { escapeXml, extractFaultCode } from '../soap/soap.js';
import {
  resolveDlnaEndpoints,
  discoverDlnaDevices,
  type DlnaEndpointInfo,
} from './discovery.js';
import { DlnaEventSubscriber, type DlnaEventHandlers } from '../gena/eventSubscriber.js';

/**
 * A UPnP control point (SOAP client) for driving an external AVTransport /
 * RenderingControl renderer — the "we push to an external renderer" side, the
 * inverse of a MediaRenderer server.
 *
 * The caller supplies the stream URI and a ready-made DIDL-Lite metadata string;
 * this class owns the protocol: endpoint discovery, the SOAP POST with its
 * device quirks (silent-timeout-as-accepted, 701 TRANSITIONING retry on Play),
 * strict command serialization so overlapping Stop/SetURI/Play can't interleave,
 * and optional GENA event subscription for device-side state.
 */
export interface DlnaControlPointOptions {
  /** Renderer IP or hostname. When set, control URLs are resolved via SSDP against this host. */
  host?: string;
  /** Manual AVTransport control URL. Skips discovery for playback. */
  controlUrl?: string;
  /** Manual RenderingControl control URL. Derived from controlUrl when omitted. */
  renderingControlUrl?: string;
  /** When no host is set, browse the network via SSDP and match a renderer. Defaults to true. */
  autoDiscover?: boolean;
  /** Match a discovered renderer by its friendly name. */
  deviceName?: string;
  /** Default per-command timeout. Defaults to 2500ms. */
  commandTimeoutMs?: number;
  /** Optional structured logger. When omitted, the control point is silent. */
  logger?: UpnpLogger;
}

interface InvokeOptions {
  optional?: boolean;
  retryDelayMs?: number;
  timeoutMs?: number;
  timeoutOk?: boolean;
  softFaultOk?: boolean;
  onTimeout?: () => void;
  // SOAP errorCodes that should be treated as a transient failure (retry) rather than a
  // hard fault or a soft-accept. E.g. 701 "Transition not available" on Play.
  retryFaultCodes?: string[];
}

export class DlnaControlPoint {
  private readonly log?: UpnpLogger;
  private readonly controllers = new Set<AbortController>();
  private readonly commandTimeoutMs: number;
  private host: string;
  private controlUrl?: string;
  private renderingControlUrl?: string;
  private discoveryPromise?: Promise<boolean>;
  private readonly autoDiscover: boolean;
  private readonly deviceName: string;
  // Push output is stateful: every setUri/play sends a full Stop→SetURI→Play sequence to
  // physical hardware, and callers may fire it in a burst. We serialize commands into a
  // single chain so overlapping sequences can't interleave — otherwise a renderer can be
  // left stuck TRANSITIONING and every Play faults with 701.
  private commandChain: Promise<void> = Promise.resolve();
  // GENA event subscriber for device-side state (play/pause/stop/volume from the renderer).
  private eventSubscriber?: DlnaEventSubscriber;
  private eventHandlers?: DlnaEventHandlers;
  private eventCallbackHost = '127.0.0.1';
  private avTransportEventUrl?: string;
  private renderingControlEventUrl?: string;
  private eventDiscoveryStarted = false;

  constructor(opts: DlnaControlPointOptions = {}) {
    this.log = opts.logger;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 2500;
    this.host = typeof opts.host === 'string' ? opts.host.trim() : '';
    this.autoDiscover = opts.autoDiscover ?? true;
    this.deviceName =
      typeof opts.deviceName === 'string' && opts.deviceName.trim().length > 0
        ? opts.deviceName.trim()
        : '';
    if (typeof opts.controlUrl === 'string' && opts.controlUrl.trim().length > 0) {
      this.controlUrl = opts.controlUrl.trim();
      this.renderingControlUrl =
        typeof opts.renderingControlUrl === 'string' && opts.renderingControlUrl.trim().length > 0
          ? opts.renderingControlUrl.trim()
          : this.deriveRenderingUrl(this.controlUrl);
      this.log?.info?.('DLNA control point configured with manual control URL', {
        controlUrl: this.controlUrl,
      });
    } else if (typeof opts.renderingControlUrl === 'string' && opts.renderingControlUrl.trim()) {
      this.renderingControlUrl = opts.renderingControlUrl.trim();
    }
  }

  /**
   * Resolve the control URLs. Returns true once an AVTransport control URL is
   * known (from manual config or SSDP discovery). Concurrent callers share one
   * in-flight discovery.
   */
  public async ensureEndpoints(): Promise<boolean> {
    if (this.controlUrl) {
      // Control URL is known (manual config or prior discovery), so playback works. But event
      // URLs may not be resolved yet — a manually-configured controlUrl skips discovery
      // entirely. Fetch the device description once in the background to enable GENA eventing
      // (bidirectional state) without blocking playback.
      if (
        this.host &&
        this.eventHandlers &&
        !this.avTransportEventUrl &&
        !this.renderingControlEventUrl &&
        !this.eventDiscoveryStarted
      ) {
        this.eventDiscoveryStarted = true;
        void this.resolveEventEndpoints();
      }
      return true;
    }
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    if (!this.host && !this.autoDiscover) {
      this.log?.warn?.('DLNA command skipped; no host or control URL configured');
      return false;
    }
    this.discoveryPromise = this.resolveEndpoints().finally(() => {
      this.discoveryPromise = undefined;
    });
    return this.discoveryPromise;
  }

  /**
   * SetAVTransportURI: hand the renderer a stream URI plus a caller-supplied
   * DIDL-Lite metadata string, then Play. Sends the full Stop→SetURI→Play
   * sequence, serialized against any other in-flight command.
   */
  public async setUri(uri: string, didlMetadata: string): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    return this.enqueueResult(() => this.sendPlaybackWithSoap(uri, didlMetadata));
  }

  /**
   * Re-send SetAVTransportURI ONLY (no Stop/Play) so the renderer adopts richer
   * metadata (e.g. title/duration arriving after the initial play) without
   * interrupting playback. Serialized against other commands.
   */
  public async updateMetadata(uri: string, didlMetadata: string): Promise<boolean> {
    if (!this.controlUrl) {
      return false;
    }
    return this.enqueueResult(() =>
      this.invokeActionWithRetry('SetAVTransportURI', this.buildSetUriBody(uri, didlMetadata), 1, {
        timeoutMs: 1500,
        timeoutOk: true,
      }),
    );
  }

  public async play(): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    return this.enqueueResult(() => this.invokeAction('Play', this.buildPlayBody()));
  }

  public async pause(): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    return this.enqueueResult(() => this.invokeAction('Pause', this.buildPauseBody()));
  }

  public async stop(): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    return this.enqueueResult(() => this.invokeAction('Stop', this.buildStopBody()));
  }

  public async setVolume(percent: number): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    const url = this.renderingControlUrl;
    if (!url) {
      this.log?.debug?.('rendering control URL missing; skipping volume update');
      return false;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const ok = await this.invokeRenderingAction('SetVolume', this.buildSetVolumeBody(clamped), {
      optional: true,
    });
    if (ok) {
      this.log?.info?.('DLNA volume set', { volume: clamped });
    }
    return ok;
  }

  /**
   * Subscribe to GENA events (transport state, volume/mute) from the renderer.
   * Resolves the event endpoints (via discovery when only a control URL is
   * known) and starts a DlnaEventSubscriber. `localHost` is the LAN address the
   * renderer should call back to.
   */
  public async subscribeEvents(handlers: DlnaEventHandlers, localHost = '127.0.0.1'): Promise<void> {
    this.eventHandlers = handlers;
    this.eventCallbackHost = localHost;
    // Make sure endpoints (and, for a manual controlUrl, background event discovery) are resolved.
    await this.ensureEndpoints();
    if (!this.avTransportEventUrl && !this.renderingControlEventUrl) {
      // Endpoints not known yet (manual controlUrl-only, or discovery hasn't populated them).
      // resolveEventEndpoints() kicked off by ensureEndpoints will call ensureEventSubscription
      // once URLs arrive; nothing more to do here.
      if (!this.host) {
        this.log?.debug?.('no event endpoints and no host; GENA subscription unavailable');
      }
      return;
    }
    this.ensureEventSubscription();
  }

  public dispose(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
    this.eventSubscriber?.dispose();
    this.eventSubscriber = undefined;
    this.log?.debug?.('DLNA control point disposed');
  }

  private async resolveEndpoints(): Promise<boolean> {
    // Without an explicit host, browse the network and match a renderer by friendly name.
    if (!this.host && this.autoDiscover) {
      const resolvedHost = await this.autoResolveHost();
      if (!resolvedHost) {
        return false;
      }
      this.host = resolvedHost;
    }
    const info = await resolveDlnaEndpoints({ host: this.host, logger: this.log });
    if (info) {
      this.applyDiscoveredEndpoints(info);
      return Boolean(this.controlUrl);
    }
    this.log?.warn?.('no DLNA endpoints discovered', { host: this.host });
    return false;
  }

  /**
   * Best-effort background fetch of the renderer's event (GENA) endpoints when only a control
   * URL was known. Does not affect playback; on success it starts the event subscription.
   */
  private async resolveEventEndpoints(): Promise<void> {
    try {
      const info = await resolveDlnaEndpoints({ host: this.host, logger: this.log });
      if (info?.avTransportEventUrl || info?.renderingControlEventUrl) {
        if (info.avTransportEventUrl) {
          this.avTransportEventUrl = info.avTransportEventUrl;
        }
        if (info.renderingControlEventUrl) {
          this.renderingControlEventUrl = info.renderingControlEventUrl;
        }
        this.ensureEventSubscription();
      }
    } catch (err) {
      this.log?.debug?.('DLNA event endpoint resolve failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async autoResolveHost(): Promise<string> {
    const devices = await discoverDlnaDevices({ logger: this.log });
    if (!devices.length) {
      this.log?.warn?.('DLNA auto-discovery found no renderers', { deviceName: this.deviceName });
      return '';
    }
    const preferred = this.deviceName.toLowerCase();
    const match =
      (preferred
        ? devices.find((device) => (device.name ?? '').toLowerCase() === preferred)
        : undefined) ?? devices[0];
    if (!match?.host) {
      return '';
    }
    this.log?.info?.('DLNA renderer auto-discovered', {
      host: match.host,
      name: match.name,
      matchedByName: (match.name ?? '').toLowerCase() === preferred,
    });
    return match.host;
  }

  private async sendPlaybackWithSoap(uri: string, didl: string): Promise<boolean> {
    this.log?.info?.('sending playback command', { uri });
    await this.invokeAction('Stop', this.buildStopBody(), { optional: true });

    // Many renderers (measured: B&O/QPlay) accept SetAVTransportURI but never send a SOAP
    // reply, so a long timeout just stalls us for the full window before Play — this was the
    // ~minute start delay. Use a short timeout and treat a timeout as "probably accepted":
    // the renderer has taken the URI, and the Play step below (with 701 retry) confirms it.
    // Single attempt: a renderer that replies does so in well under this window, and one that
    // stays silent won't reply to a retry either — retrying only stacks another stall. The
    // Play step's 701 retry is the real readiness check, so a slightly-too-short window here
    // is harmless: Play just retries until the renderer is out of TRANSITIONING.
    let timedOut = false;
    const didSetUri = await this.invokeActionWithRetry('SetAVTransportURI', this.buildSetUriBody(uri, didl), 1, {
      timeoutMs: 1500,
      timeoutOk: true,
      onTimeout: () => {
        timedOut = true;
      },
    });

    // A hard fault on SetURI (false *without* a timeout) means the renderer rejected the URI.
    // A silent timeout means the URI was likely set, so proceed straight to Play.
    if (!didSetUri && !timedOut) {
      this.log?.warn?.('DLNA SetAVTransportURI faulted; proceeding to Play anyway');
    }

    await delay(200);
    // Retry Play while the renderer may still be TRANSITIONING (701). Renderers that replied
    // to SetURI are ready almost immediately; silent ones (timedOut) get a touch more slack.
    const playAttempts = 6;
    const playDelay = timedOut ? 600 : 300;
    if (
      !(await this.invokeActionWithRetry('Play', this.buildPlayBody(), playAttempts, {
        retryDelayMs: playDelay,
        retryFaultCodes: ['701'],
      }))
    ) {
      this.log?.warn?.('DLNA Play did not succeed after retries', { uri });
      return false;
    }
    this.log?.info?.('DLNA playback started', { uri });
    return true;
  }

  /**
   * Run a task strictly after any previous one for this control point has settled, so
   * overlapping Stop/SetURI/Play sequences can never interleave on the renderer.
   */
  private enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    const run = this.commandChain.then(task, task);
    // Keep the chain alive even if a task throws, but don't leak the rejection.
    this.commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async invokeActionWithRetry(
    action: string,
    body: string,
    attempts: number,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const success = await this.invokeAction(action, body, options);
      if (success) {
        return true;
      }
      if (attempt < attempts) {
        await delay(options.retryDelayMs ?? 150);
      }
    }
    return false;
  }

  private async invokeAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.controlUrl) {
      this.log?.warn?.('AVTransport command skipped; endpoint unknown', { action });
      return false;
    }
    return this.invokeServiceAction(this.controlUrl, 'AVTransport', action, body, options);
  }

  private async invokeRenderingAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.renderingControlUrl) {
      this.log?.debug?.('RenderingControl command skipped; endpoint unknown', { action });
      return false;
    }
    return this.invokeServiceAction(
      this.renderingControlUrl,
      'RenderingControl',
      action,
      body,
      options,
    );
  }

  private async invokeServiceAction(
    url: string,
    service: 'AVTransport' | 'RenderingControl',
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.commandTimeoutMs);
    timeout.unref();
    try {
      this.log?.debug?.('DLNA soap request', { action, service });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
        },
        body,
        signal: controller.signal,
      });

      let text = '';
      try {
        text = await response.text();
      } catch (err) {
        this.log?.debug?.('dlna control response read failed', {
          status: response.status,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!response.ok && response.status !== 500) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      if (response.ok) {
        this.log?.info?.('DLNA action succeeded', { action, service });
        return true;
      }
      const fault = text.slice(0, 2000);
      // Some renderers (notably B&O/QPlay) briefly sit in TRANSITIONING right after
      // SetAVTransportURI and reject Play with 701 "Transition not available". That's a
      // transient we want to *retry*, not soft-accept — soft-accepting reports success while
      // the renderer never actually started (this was the source of the long start delay).
      const errorCode = extractFaultCode(fault);
      if (errorCode && options.retryFaultCodes?.includes(errorCode)) {
        this.log?.debug?.('DLNA action returned retryable SOAP fault', {
          action,
          service,
          errorCode,
        });
        return false;
      }
      this.log?.warn?.('DLNA action returned SOAP fault', {
        action,
        status: response.status,
        service,
        body: fault,
      });
      if (options.softFaultOk) {
        return true;
      }
      return options.optional ?? false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort && options.timeoutOk) {
        this.log?.debug?.('DLNA request timed out; continuing', { action, service });
        options.onTimeout?.();
        return false;
      }
      if (options.optional) {
        this.log?.debug?.('optional command failed', { action, service, message });
      } else {
        this.log?.warn?.('command failed', { action, service, message });
      }
      return options.optional ?? false;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private buildSetUriBody(uri: string, didl: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;
  }

  private buildPlayBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
  }

  private buildPauseBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Pause>
  </s:Body>
</s:Envelope>`;
  }

  private buildStopBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;
  }

  private buildSetVolumeBody(volume: number): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>${volume}</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>`;
  }

  private deriveRenderingUrl(avTransportUrl: string): string | undefined {
    try {
      const parsed = new URL(avTransportUrl);
      if (parsed.pathname.toLowerCase().includes('avtransport')) {
        parsed.pathname = parsed.pathname.replace(/AVTransport/gi, 'RenderingControl');
      } else {
        parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/RenderingControl/Control`;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private applyDiscoveredEndpoints(info: DlnaEndpointInfo): void {
    if (info.controlUrl) {
      this.controlUrl = info.controlUrl;
    }
    if (info.renderingControlUrl) {
      this.renderingControlUrl = info.renderingControlUrl;
    } else if (this.controlUrl && !this.renderingControlUrl) {
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
    }
    if (info.avTransportEventUrl) {
      this.avTransportEventUrl = info.avTransportEventUrl;
    }
    if (info.renderingControlEventUrl) {
      this.renderingControlEventUrl = info.renderingControlEventUrl;
    }
    this.log?.info?.('DLNA discovery completed', {
      host: this.host,
      controlUrl: this.controlUrl,
    });
    this.ensureEventSubscription();
  }

  /**
   * Start (or refresh) GENA event subscriptions so device-side actions (play/pause/stop on the
   * renderer, volume knob) flow back to the caller's handlers. Only runs when the caller asked
   * for events (subscribeEvents) and the renderer advertised event endpoints; manual
   * controlUrl-only configs won't have them.
   */
  private ensureEventSubscription(): void {
    if (!this.eventHandlers) {
      return;
    }
    if (!this.avTransportEventUrl && !this.renderingControlEventUrl) {
      return;
    }
    if (!this.eventSubscriber) {
      this.eventSubscriber = new DlnaEventSubscriber(0, this.eventCallbackHost, this.eventHandlers, {
        logger: this.log,
      });
    }
    void this.eventSubscriber.start({
      avTransportEventUrl: this.avTransportEventUrl,
      renderingControlEventUrl: this.renderingControlEventUrl,
    });
  }
}
