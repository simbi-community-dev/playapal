/**
 * The impure half of video calls (docs/VIDEO-CALLS.md §4): binds the pure
 * reducer (videoCall.ts) to the real world — react-native-webrtc for
 * capture/encode/transport, the walkie's signal frames for control, RN
 * timers and AppState. Everything decision-shaped lives in the reducer and
 * the signaler, both fully unit-tested; this file is deliberately thin
 * glue whose correctness the device build proves.
 *
 * WHY WEBRTC (probe, 2026-08-25): RN 0.87 in this tree still ships the
 * legacy ViewManager interop renderer (node_modules/react-native/
 * ReactCommon/react/renderer/components/legacyviewmanagerinterop) with
 * useFabricInterop() defaulting true, and this app's own classic bridge
 * modules (WalkieModule) run in the field on this exact RN — so the
 * library's legacy module + view surface has a live path. WebRTC's Google
 * Congestion Control is the owner's "automatic bitrate maxing for the
 * bandwidth", delivered by the encoder instead of re-implemented badly.
 *
 * OFFLINE BY CONSTRUCTION: iceServers is EMPTY. No STUN, no TURN, no
 * internet — the only ICE candidates that can exist are host candidates
 * on the interfaces the phones already share (camp LAN, hotspot, Aware).
 * If no shared path exists, ICE fails and the reducer says the honest
 * sentence instead of spinning.
 */
import {
  AppState,
  NativeModules,
  PermissionsAndroid,
  Platform,
  type AppStateStatus,
  type NativeEventSubscription,
} from 'react-native';
import { ReliableSignaler, type SignalEnvelope } from './callSignal';
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_RING_TIMEOUT_MS,
  callVideoOn,
  idleCall,
  reduceCall,
  type CallEffect,
  type CallEvent,
  type CallModel,
} from './videoCall';
import {
  onWalkieSignal,
  sendWalkieSignal,
  walkieSignalPresent,
} from './walkie';
import {
  callRingTransition,
  clearCallRing,
  notifyCallRing,
} from './pocketAlerts';

// Minimal local types for the lazily-required module — react-native-webrtc
// is only ever loaded through loadRtc() so a build (or test) without the
// native module degrades to "no call button" instead of a startup crash.
interface RtcTrack {
  kind: string;
  enabled: boolean;
  stop(): void;
  _switchCamera?: () => void;
}
interface RtcStream {
  getTracks(): RtcTrack[];
  getVideoTracks(): RtcTrack[];
  getAudioTracks(): RtcTrack[];
  toURL(): string;
}
interface RtcSessionDescription {
  type: string;
  sdp: string;
}
interface RtcIceEvent {
  candidate?: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  } | null;
}
interface RtcPeerConnection {
  connectionState?: string;
  onicecandidate: ((ev: RtcIceEvent) => void) | null;
  ontrack: ((ev: { streams?: RtcStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createOffer(options?: unknown): Promise<RtcSessionDescription>;
  createAnswer(): Promise<RtcSessionDescription>;
  setLocalDescription(d?: unknown): Promise<void>;
  setRemoteDescription(d: unknown): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  addTrack(t: RtcTrack, ...streams: RtcStream[]): unknown;
  close(): void;
}
interface RtcModule {
  RTCPeerConnection: new (config: unknown) => RtcPeerConnection;
  RTCIceCandidate: new (init: unknown) => unknown;
  RTCSessionDescription: new (init: unknown) => unknown;
  mediaDevices: { getUserMedia(constraints: unknown): Promise<RtcStream> };
}

function loadRtc(): RtcModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-webrtc') as RtcModule;
  } catch {
    // The module throws at require time when its native half is absent.
    return null;
  }
}

/** Can this build place a call at all? Needs the walkie's signal seam (a
 * new native method — an older native answers false) AND the WebRTC
 * native module. False = no call button, never a dead one. */
export function callsPresent(): boolean {
  if (!walkieSignalPresent() || NativeModules.WebRTCModule == null) {
    return false;
  }
  return loadRtc() != null;
}

export interface CallSnapshot {
  model: CallModel;
  localStreamUrl: string | null;
  remoteStreamUrl: string | null;
}

/** How long a vanished roster entry may stay vanished before the call
 * declares the peer lost. mDNS flaps; ten seconds outlasts a flap and is
 * still honest about a walked-away phone. */
export const CALL_PEER_GONE_GRACE_MS = 10_000;

/** How long ICE 'disconnected' may persist before it is treated as
 * 'failed'. WebRTC recovers brief disconnects on its own. */
const DISCONNECT_GRACE_MS = 8_000;

/** Signal retransmit pump cadence — coarse on purpose; the signaler's own
 * SIGNAL_RETRY_MS is the real clock and this only has to sample it. */
const TICK_MS = 500;

export class CallRuntime {
  private model: CallModel = idleCall;
  private signalers = new Map<number, ReliableSignaler>();
  private listeners = new Set<(snap: CallSnapshot) => void>();
  private offSignal: (() => void) | null = null;
  private appStateSub: NativeEventSubscription | null = null;

  private pc: RtcPeerConnection | null = null;
  private localStream: RtcStream | null = null;
  private remoteStream: RtcStream | null = null;
  private remoteDescSet = false;
  private pendingSdp: SignalEnvelope | null = null;
  private pendingIce: SignalEnvelope[] = [];

  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private peerGoneTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private myName: string) {}

  start(): void {
    this.offSignal = onWalkieSignal(s => {
      this.signalerFor(s.from).receive(s.payload, Date.now());
    });
    this.appStateSub = AppState.addEventListener('change', st =>
      this.onAppState(st),
    );
  }

  destroy(): void {
    if (
      this.model.phase === 'calling' ||
      this.model.phase === 'connecting' ||
      this.model.phase === 'live'
    ) {
      // Best-effort bye — the first transmission leaves before teardown.
      this.dispatch({ type: 'hangup' });
    }
    this.offSignal?.();
    this.offSignal = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
    // A runtime torn down mid-ring (walkie closed, panel unmounted) takes
    // its shade entry with it — the dispatch above only covers reduced
    // exits, and destroy is the one exit that never reduces.
    clearCallRing();
    this.clearCallTimers();
    if (this.peerGoneTimer) {
      clearTimeout(this.peerGoneTimer);
      this.peerGoneTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.closeMedia();
    this.listeners.clear();
  }

  subscribe(cb: (snap: CallSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  snapshot(): CallSnapshot {
    const active =
      this.model.phase === 'connecting' || this.model.phase === 'live';
    return {
      model: this.model,
      localStreamUrl: active && this.localStream ? this.localStream.toURL() : null,
      remoteStreamUrl:
        active && this.remoteStream ? this.remoteStream.toURL() : null,
    };
  }

  // ------------------------------------------------------------ user verbs

  place(peerHash: number, peerName: string): void {
    const call = (Math.floor(Math.random() * 0x100000000) >>> 0).toString(16);
    this.dispatch({ type: 'place', peerHash, peerName, call });
  }

  answer(): void {
    this.dispatch({ type: 'answer' });
  }

  decline(): void {
    this.dispatch({ type: 'decline' });
  }

  hangUp(): void {
    this.dispatch({ type: 'hangup' });
  }

  dismiss(): void {
    this.dispatch({ type: 'dismiss' });
  }

  toggleVideo(): void {
    this.dispatch({ type: 'toggle-video' });
  }

  toggleMic(): void {
    this.dispatch({ type: 'toggle-mic' });
  }

  flipCamera(): void {
    for (const t of this.localStream?.getVideoTracks() ?? []) {
      t._switchCamera?.();
    }
  }

  /** The panel feeds every WalkiePeers roster here; a call peer missing
   * from the roster for CALL_PEER_GONE_GRACE_MS tears the call down with
   * the honest 'lost' sentence instead of a silent black tile. */
  notePeers(present: Set<number>): void {
    const peer = this.model.peerHash;
    const active = this.model.phase !== 'idle' && this.model.phase !== 'ended';
    if (peer == null || !active || present.has(peer)) {
      if (this.peerGoneTimer) {
        clearTimeout(this.peerGoneTimer);
        this.peerGoneTimer = null;
      }
      return;
    }
    if (!this.peerGoneTimer) {
      this.peerGoneTimer = setTimeout(() => {
        this.peerGoneTimer = null;
        this.dispatch({ type: 'peer-gone', hash: peer });
      }, CALL_PEER_GONE_GRACE_MS);
    }
  }

  // ------------------------------------------------------------ machinery

  private emit(): void {
    const snap = this.snapshot();
    for (const cb of this.listeners) {
      cb(snap);
    }
  }

  private dispatch(e: CallEvent): void {
    const before = this.model.phase;
    const { model, effects } = reduceCall(this.model, e);
    this.model = model;
    // THE POCKET RING (pocketAlerts.ts). Deliberately keyed off the SAME
    // reduced phase the in-app ringing panel renders — the 'invite' event
    // goes through reduceCall exactly once and both surfaces read its
    // verdict, so there is no second call state machine to drift. If an
    // in-flight ring-anywhere lane widens where the runtime LIVES, this
    // line rides along untouched: whatever dispatches the invite, the
    // reducer's 'ringing' is the single source of ring truth. Entering
    // rings the shade (suppressed inside notifyCallRing when the app is
    // visible); leaving clears it on EVERY exit arc — answer, decline,
    // caller's bye, ring-timeout — a stale "X is calling" in a pocket is
    // a lie.
    const ring = callRingTransition(before, model.phase);
    if (ring === 'show') {
      notifyCallRing(model.peerName ?? 'Your podmate');
    } else if (ring === 'clear') {
      clearCallRing();
    }
    for (const eff of effects) {
      this.runEffect(eff);
    }
    this.emit();
  }

  private runEffect(eff: CallEffect): void {
    switch (eff.do) {
      case 'send': {
        const msg =
          eff.msg.t === 'invite' ? { ...eff.msg, name: this.myName } : eff.msg;
        this.signalerFor(eff.to).post(msg as SignalEnvelope, Date.now());
        this.ensureTicker();
        break;
      }
      case 'open-media':
        void this.openMedia();
        break;
      case 'close-media':
        this.closeMedia();
        break;
      case 'arm-ring-timeout':
        this.ringTimer = setTimeout(
          () => this.dispatch({ type: 'ring-timeout' }),
          CALL_RING_TIMEOUT_MS,
        );
        break;
      case 'arm-connect-timeout':
        this.connectTimer = setTimeout(
          () => this.dispatch({ type: 'connect-timeout' }),
          CALL_CONNECT_TIMEOUT_MS,
        );
        break;
      case 'clear-timers':
        this.clearCallTimers();
        break;
      case 'apply-video':
        for (const t of this.localStream?.getVideoTracks() ?? []) {
          t.enabled = eff.on;
        }
        break;
      case 'apply-mic':
        for (const t of this.localStream?.getAudioTracks() ?? []) {
          t.enabled = eff.on;
        }
        break;
    }
  }

  private clearCallTimers(): void {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private signalerFor(hash: number): ReliableSignaler {
    let s = this.signalers.get(hash);
    if (!s) {
      s = new ReliableSignaler(
        (b64, fanout) => {
          void sendWalkieSignal(hash, b64, fanout).catch((e: unknown) => {
            // An unreachable peer is the retransmit loop's problem; the
            // bounded tries turn persistent failure into signal-dead.
            //
            // EXCEPT for one reason, which is the whole point of this
            // lane. `stale` means the native side found this podmate's
            // rows and refused because none of them has PROVEN it is
            // alive (WALKIE-LADDER §5b) — a fact about the road, not the
            // moment, so retrying the same way cannot help. Telling the
            // signaler widens every send from here on. It does NOT count
            // as a try and does NOT kill the signaler: the demotion
            // window is ~12 s and the retransmit budget is 8 s, so a
            // signaler that gave up on the first stale reject would end
            // the call in exactly the window it exists to survive.
            const code = (e as { code?: unknown } | null | undefined)?.code;
            if (code === 'stale') {
              this.signalers.get(hash)?.noteSendMiss();
            }
          });
        },
        env => this.onSignal(hash, env),
        () => {
          // Eight seconds of silence is a verdict about THIS peer's
          // transport. Drop everything still queued to them — the stale
          // bye that otherwise died 8 s into the NEXT call and fired a
          // second signal-dead at it — and name WHO died, so the reducer
          // can ignore a dead message to anyone but the active call's
          // peer (a busy to a caller who left, a bye to a ghost).
          this.signalers.get(hash)?.reset();
          this.dispatch({ type: 'signal-dead', from: hash });
        },
      );
      this.signalers.set(hash, s);
    }
    return s;
  }

  private ensureTicker(): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      let busy = false;
      const now = Date.now();
      for (const s of this.signalers.values()) {
        s.tick(now);
        busy = busy || s.busy();
      }
      if (!busy && this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }, TICK_MS);
  }

  private onAppState(st: AppStateStatus): void {
    this.dispatch({
      type: st === 'active' ? 'app-foreground' : 'app-background',
    });
  }

  private onSignal(from: number, env: SignalEnvelope): void {
    const call = typeof env.call === 'string' ? env.call : null;
    switch (env.t) {
      case 'invite':
        if (call) {
          this.dispatch({
            type: 'invite',
            from,
            name: typeof env.name === 'string' ? env.name : 'someone',
            call,
          });
        }
        return;
      case 'accept':
        if (call) {
          this.dispatch({ type: 'remote-accept', call });
        }
        return;
      case 'decline':
        if (call) {
          this.dispatch({ type: 'remote-decline', call });
        }
        return;
      case 'busy':
        if (call) {
          this.dispatch({ type: 'remote-busy', call });
        }
        return;
      case 'bye':
        if (call) {
          this.dispatch({ type: 'bye', call });
        }
        return;
      case 'sdp':
        if (from === this.model.peerHash && call === this.model.callId) {
          void this.onSdp(env);
        }
        return;
      case 'ice':
        if (from === this.model.peerHash && call === this.model.callId) {
          void this.onIce(env);
        }
        return;
      default:
        return; // an unknown control kind from a newer build — ignored
    }
  }

  // ------------------------------------------------------------ media

  private async openMedia(): Promise<void> {
    const rtc = loadRtc();
    if (!rtc) {
      this.dispatch({ type: 'media-failed', why: 'other' });
      return;
    }
    if (Platform.OS === 'android') {
      // Ask in context, exactly like the PTT's mic ask: the answered call
      // is the consent gesture.
      const got = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      const ok =
        got[PermissionsAndroid.PERMISSIONS.CAMERA] ===
          PermissionsAndroid.RESULTS.GRANTED &&
        got[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
          PermissionsAndroid.RESULTS.GRANTED;
      if (!ok) {
        this.dispatch({ type: 'media-failed', why: 'permission' });
        return;
      }
    }
    let stream: RtcStream;
    try {
      stream = await rtc.mediaDevices.getUserMedia({
        audio: true,
        // 720p ceiling; GCC scales DOWN from here against the measured
        // path, which is the owner's "automatic bitrate maxing" — the
        // encoder chases whatever the LAN/Aware link actually carries.
        video: { facingMode: 'user', width: 1280, height: 720, frameRate: 30 },
      });
    } catch (e) {
      this.dispatch({
        type: 'media-failed',
        why: /permission|denied|not allowed/i.test(String(e))
          ? 'permission'
          : 'other',
      });
      return;
    }
    if (this.model.phase !== 'connecting') {
      // The call ended while the OS was asking — release the camera.
      for (const t of stream.getTracks()) {
        t.stop();
      }
      return;
    }
    this.localStream = stream;
    for (const t of stream.getVideoTracks()) {
      t.enabled = callVideoOn(this.model);
    }
    for (const t of stream.getAudioTracks()) {
      t.enabled = !this.model.micMuted;
    }
    const pc = new rtc.RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    for (const t of stream.getTracks()) {
      pc.addTrack(t, stream);
    }
    pc.onicecandidate = ev => {
      const c = ev.candidate;
      const peer = this.model.peerHash;
      if (c && peer != null) {
        this.signalerFor(peer).post(
          {
            t: 'ice',
            call: this.model.callId,
            cand: {
              candidate: c.candidate,
              sdpMid: c.sdpMid,
              sdpMLineIndex: c.sdpMLineIndex,
            },
          },
          Date.now(),
        );
        this.ensureTicker();
      }
    };
    pc.ontrack = ev => {
      const s = ev.streams && ev.streams[0];
      if (s) {
        this.remoteStream = s;
        this.emit();
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
        this.dispatch({ type: 'media-up' });
      } else if (st === 'failed') {
        this.dispatch({ type: 'link-failed' });
      } else if (st === 'disconnected' && !this.disconnectTimer) {
        // WebRTC recovers short disconnects by itself; only a persistent
        // one is a torn call.
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          this.dispatch({ type: 'link-failed' });
        }, DISCONNECT_GRACE_MS);
      }
    };
    if (this.pendingSdp) {
      const held = this.pendingSdp;
      this.pendingSdp = null;
      await this.onSdp(held);
    }
    if (this.model.offerer) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const peer = this.model.peerHash;
        if (peer != null) {
          this.signalerFor(peer).post(
            { t: 'sdp', call: this.model.callId, kind: offer.type, sdp: offer.sdp },
            Date.now(),
          );
          this.ensureTicker();
        }
      } catch {
        this.dispatch({ type: 'media-failed', why: 'other' });
      }
    }
  }

  private async onSdp(env: SignalEnvelope): Promise<void> {
    const rtc = loadRtc();
    const pc = this.pc;
    if (!rtc) {
      return;
    }
    if (!pc) {
      // The answerer's offer can outrun its own getUserMedia — hold it.
      this.pendingSdp = env;
      return;
    }
    try {
      await pc.setRemoteDescription(
        new rtc.RTCSessionDescription({ type: env.kind, sdp: env.sdp }),
      );
      this.remoteDescSet = true;
      const held = this.pendingIce;
      this.pendingIce = [];
      for (const ice of held) {
        await this.onIce(ice);
      }
      if (env.kind === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const peer = this.model.peerHash;
        if (peer != null) {
          this.signalerFor(peer).post(
            {
              t: 'sdp',
              call: this.model.callId,
              kind: answer.type,
              sdp: answer.sdp,
            },
            Date.now(),
          );
          this.ensureTicker();
        }
      }
    } catch {
      this.dispatch({ type: 'link-failed' });
    }
  }

  private async onIce(env: SignalEnvelope): Promise<void> {
    const rtc = loadRtc();
    const pc = this.pc;
    if (!rtc) {
      return;
    }
    if (!pc || !this.remoteDescSet) {
      this.pendingIce.push(env);
      return;
    }
    try {
      await pc.addIceCandidate(new rtc.RTCIceCandidate(env.cand));
    } catch {
      // One bad candidate is not a torn call; ICE keeps trying the rest.
    }
  }

  private closeMedia(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    for (const t of this.localStream?.getTracks() ?? []) {
      try {
        t.stop();
      } catch {
        // a released camera is the goal state
      }
    }
    try {
      this.pc?.close();
    } catch {
      // closing a dead connection is the goal state
    }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.remoteDescSet = false;
    this.pendingSdp = null;
    this.pendingIce = [];
  }
}
