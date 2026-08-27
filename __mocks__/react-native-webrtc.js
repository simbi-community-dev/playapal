/**
 * Manual mock for react-native-webrtc (mapped in jest.config.js). The real
 * module THROWS at require time when its native half is absent — which is
 * every jest run — so suites get this minimal, deterministic stand-in.
 * Shapes mirror only what src/crews/callRuntime.ts and VideoCallPanel.tsx
 * actually touch.
 */
const React = require('react');

class MediaStreamTrack {
  constructor(kind) {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
    this.switched = 0;
  }
  stop() {
    this.stopped = true;
  }
  _switchCamera() {
    this.switched += 1;
  }
}

class MediaStream {
  constructor(tracks) {
    this._tracks = tracks || [
      new MediaStreamTrack('audio'),
      new MediaStreamTrack('video'),
    ];
  }
  getTracks() {
    return this._tracks;
  }
  getVideoTracks() {
    return this._tracks.filter(t => t.kind === 'video');
  }
  toURL() {
    return 'mock://stream';
  }
}

class RTCSessionDescription {
  constructor(init) {
    Object.assign(this, init);
  }
}

class RTCIceCandidate {
  constructor(init) {
    Object.assign(this, init);
  }
}

class RTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.closed = false;
    this.tracks = [];
    this.remoteDescription = null;
    this.localDescription = null;
    this.addedCandidates = [];
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTrack(track, ...streams) {
    this.tracks.push({ track, streams });
    return {};
  }
  async createOffer() {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }
  async setLocalDescription(d) {
    this.localDescription = d || this.localDescription;
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c) {
    this.addedCandidates.push(c);
  }
  getSenders() {
    return [];
  }
  close() {
    this.closed = true;
  }
}

const mediaDevices = {
  getUserMedia: () => Promise.resolve(new MediaStream()),
};

const RTCView = props => React.createElement('RTCView', props);

module.exports = {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  MediaStream,
  MediaStreamTrack,
  mediaDevices,
  RTCView,
};
