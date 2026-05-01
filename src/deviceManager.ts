import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  processingFrame?: boolean;
  interactiveUntilMs: number;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const FRAME_PROCESSING_CONCURRENCY = Math.max(1, Number(process.env.FRAME_PROCESSING_CONCURRENCY) || 2);
const IDLE_FRAME_INTERVAL_MS = Math.max(250, Number(process.env.IDLE_FRAME_INTERVAL_MS) || 2000);
const ACTIVE_AFTER_INTERACTION_MS = Math.max(1000, Number(process.env.ACTIVE_AFTER_INTERACTION_MS) || 30_000);

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

let _activeFrameProcessors = 0;
const _frameProcessorWaiters: (() => void)[] = [];

async function acquireFrameProcessingSlotAsync(): Promise<() => void> {
  if (_activeFrameProcessors < FRAME_PROCESSING_CONCURRENCY) {
    _activeFrameProcessors++;
    return releaseFrameProcessingSlot;
  }

  await new Promise<void>(resolve => _frameProcessorWaiters.push(resolve));
  _activeFrameProcessors++;
  return releaseFrameProcessingSlot;
}

function releaseFrameProcessingSlot(): void {
  _activeFrameProcessors = Math.max(0, _activeFrameProcessors - 1);
  const next = _frameProcessorWaiters.shift();
  if (next) next();
}

export function markDeviceInteractive(dev: DeviceSession, requestFullFrame = false): void {
  dev.interactiveUntilMs = Date.now() + ACTIVE_AFTER_INTERACTION_MS;
  if (requestFullFrame) dev.processor.requestFullFrame();
}

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      markDeviceInteractive(device, true);
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
  if (keyboardScript) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
  }

  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    processingFrame: false,
    interactiveUntilMs: Date.now() + ACTIVE_AFTER_INTERACTION_MS,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const scheduleFlush = () => {
    const dev = newDevice;
    if (dev.processingFrame || dev.throttleTimer) return;

    const now = Date.now();
    const since = dev.lastProcessedMs ? (now - dev.lastProcessedMs) : Infinity;
    const targetInterval = now <= dev.interactiveUntilMs ? cfg.minFrameInterval : IDLE_FRAME_INTERVAL_MS;
    const delay = Math.max(0, targetInterval - (Number.isFinite(since) ? since : 0));
    dev.throttleTimer = setTimeout(flushPending, delay);
  };

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;
    if (dev.processingFrame) return;

    dev.processingFrame = true;
    try {
      const release = await acquireFrameProcessingSlotAsync();
      try {
        const b64 = dev.pendingB64;
        dev.pendingB64 = undefined;
        if (!b64) return;

        try {
          const pngFull = Buffer.from(b64, 'base64');

          const h32 = hash32(pngFull);
          if (dev.prevFrameHash === h32) {
            dev.lastProcessedMs = Date.now();
            return;
          }
          dev.prevFrameHash = h32;

          let img = sharp(pngFull);
          if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

          const { data, info } = await img
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
          if (out.rects.length > 0) {
            dev.frameId = (dev.frameId + 1) >>> 0;
            broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
          }
        } catch (e) {
          console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
        } finally {
          dev.lastProcessedMs = Date.now();
        }
      } finally {
        release();
      }
    } finally {
      dev.processingFrame = false;
      if (dev.pendingB64 && broadcaster.getClientCount(dev.deviceId) > 0)
        scheduleFlush();
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;
    scheduleFlush();
  });

  const handleNavigation = (url: string) => {
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);
    }
  };

  session.on('Page.frameNavigated', (evt: any) => {
    // Only track the main frame, ignore iframes
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleNavigation(evt.url);
  });
  
  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}
