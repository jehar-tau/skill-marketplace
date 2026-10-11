import { AppState } from 'react-native';
import { getAccessToken } from './api';
import { wsUrl } from './config';

export type LiveEvent =
  | { type: 'message'; conversationId: string; seq: number }
  | { type: 'receipt'; conversationId: string }
  | { type: 'match'; matchId: string }
  | { type: 'request'; requestId: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'agreement'; conversationId: string }
  | { type: 'resync' };

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let wanted = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let pinger: ReturnType<typeof setInterval> | null = null;

const emit = (e: LiveEvent) => listeners.forEach((l) => l(e));

export function onLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function open() {
  const token = getAccessToken();
  if (!wanted || !token || socket) return;
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(String(m.data));
      if (e.type === 'ready') {
        attempt = 0;
        // Anything that changed while disconnected is picked up by a full refresh.
        emit({ type: 'resync' });
      } else if (e.type !== 'pong') emit(e);
    } catch {
      // ignore
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (pinger) clearInterval(pinger);
    if (!wanted) return;
    // Back off up to 30 seconds on a poor network.
    timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++));
  };
  ws.onerror = () => ws.close();
  pinger = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25_000);
}

export function connectLive() {
  wanted = true;
  open();
}

export function disconnectLive() {
  wanted = false;
  if (timer) clearTimeout(timer);
  socket?.close();
  socket = null;
}

AppState.addEventListener('change', (state) => {
  if (state === 'active' && wanted) {
    if (!socket) open();
    emit({ type: 'resync' });
  }
});
