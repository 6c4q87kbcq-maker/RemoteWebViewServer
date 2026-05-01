import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId?: number | null; packets: Buffer[]; respectBackpressure: boolean };
type BroadcasterState = {
  latestFrame?: OutFrame;
  controlQueue: OutFrame[];
  sending: boolean;
  droppedFrames: number;
};

const WS_HIGH_WATER_BYTES = Math.max(64 * 1024, Number(process.env.WS_HIGH_WATER_BYTES) || 512 * 1024);
const MAX_CONTROL_QUEUE = 8;

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  addClient(id: string, ws: WebSocket): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      for (const sock of old) {
        try { sock.close(); } catch {}
      }
      old.clear();
    }

    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);

    if (!this._state.has(id)) this._state.set(id, { controlQueue: [], sending: false, droppedFrames: 0 });

    console.log(`[broadcaster] Client connected to device ${id}, total clients: ${this._clients.get(id)?.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);

    const st = this._ensureState(id);
    if (st.latestFrame) st.droppedFrames++;
    st.latestFrame = { frameId, packets, respectBackpressure: true };
    this._drainAsync(id).catch(() => {});
  }

  public startSelfTestMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    this._enqueueControl(id, { packets: [buildFrameStatsPacket()], respectBackpressure: false });
  }

  public sendCurrentURL(id: string, url: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    this._enqueueControl(id, { packets: [buildCurrentURLPacket(url)], respectBackpressure: false });
  }

  private _enqueueControl(id: string, frame: OutFrame): void {
    const st = this._ensureState(id);
    st.controlQueue.push(frame);
    if (st.controlQueue.length > MAX_CONTROL_QUEUE) st.controlQueue.shift();
    this._drainAsync(id).catch(() => {});
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { controlQueue: [], sending: false, droppedFrames: 0 };
      this._state.set(id, st);
    }
    return st;
  }

  private _nextFrame(st: BroadcasterState): OutFrame | undefined {
    const control = st.controlQueue.shift();
    if (control) return control;

    const latest = st.latestFrame;
    st.latestFrame = undefined;
    return latest;
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) {
        st.controlQueue.length = 0;
        st.latestFrame = undefined;
        return;
      }

      let f: OutFrame | undefined;
      while ((f = this._nextFrame(st))) {
        const readyPeers = new Set<WebSocket>();

        for (const ws of new Set(peers)) {
          if (ws.readyState !== WebSocket.OPEN) {
            peers.delete(ws);
            continue;
          }
          if (f.respectBackpressure && ws.bufferedAmount > WS_HIGH_WATER_BYTES) {
            st.droppedFrames++;
            continue;
          }
          readyPeers.add(ws);
        }

        if (readyPeers.size === 0) {
          if (peers.size === 0) {
            st.controlQueue.length = 0;
            st.latestFrame = undefined;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }

        for (const pkt of f.packets) {
          for (const ws of new Set(readyPeers)) {
            if (ws.readyState !== WebSocket.OPEN) {
              peers.delete(ws);
              readyPeers.delete(ws);
              continue;
            }
            try {
              ws.send(pkt, { binary: true });
            } catch {
              try { ws.close(); } catch {}
              peers.delete(ws);
              readyPeers.delete(ws);
            }
          }
          if (peers.size === 0) {
            st.controlQueue.length = 0;
            st.latestFrame = undefined;
            return;
          }
          await Promise.resolve();
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
