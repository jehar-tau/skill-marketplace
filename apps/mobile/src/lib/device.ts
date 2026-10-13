import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { getJson, setJson } from './storage';

export interface Place {
  lat: number;
  lng: number;
  label?: string;
}

export const savedPlace = () => getJson<Place | null>('place', null);
export const savePlace = (p: Place) => setJson('place', p);

// Asks for location only when it is first needed (spec §5.1). Returns null if declined or unavailable.
export async function currentPlace(): Promise<Place | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const place = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    await savePlace(place);
    return place;
  } catch {
    return null;
  }
}

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

// A dedicated high-importance channel is what makes a request alert sound and show at once on Android (spec §6).
async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('requests', {
    name: 'New requests',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 200, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync('messages', { name: 'Messages', importance: Notifications.AndroidImportance.DEFAULT });
}

// ---- Browser push (the web app). Works on Android browsers, and on iPhone only
// after the site has been added to the home screen.
const web = globalThis as any;
const webPushSupported = () => Platform.OS === 'web' && 'serviceWorker' in (web.navigator ?? {}) && 'PushManager' in web && 'Notification' in web;

function keyBytes(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(web.atob(b64), (c: string) => c.charCodeAt(0));
}

async function enableWebPush(ask: boolean): Promise<boolean> {
  if (!webPushSupported()) return false;
  let permission: string = web.Notification.permission;
  if (permission === 'default' && ask) permission = await web.Notification.requestPermission();
  if (permission !== 'granted') return false;
  const registration = await web.navigator.serviceWorker.register('/sw.js');
  await web.navigator.serviceWorker.ready;
  const { webPushKey } = await api('/v1/config', { auth: false });
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(webPushKey) }));
  await api('/v1/me/device', { method: 'PATCH', body: { pushToken: 'webpush:' + JSON.stringify(subscription) } });
  return true;
}

// Lets the browser offer "Add to Home screen", which is also what makes alerts work on iPhone.
export function linkWebManifest() {
  if (Platform.OS !== 'web' || !web.document || web.document.querySelector('link[rel="manifest"]')) return;
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = web.document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    web.document.head.appendChild(el);
  };
  add('link', { rel: 'manifest', href: '/manifest.json' });
  add('link', { rel: 'apple-touch-icon', href: '/icon-192.png' });
  add('meta', { name: 'theme-color', content: '#0F6B57' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
}

export const pushPossible = () => Platform.OS !== 'web' || webPushSupported();

export async function notificationsGranted(): Promise<boolean> {
  if (Platform.OS === 'web') return webPushSupported() && web.Notification.permission === 'granted';
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

// Requests permission, registers the device with the server, and reports whether alerts will arrive.
export async function enablePush(ask: boolean): Promise<boolean> {
  if (Platform.OS === 'web') return enableWebPush(ask).catch(() => false);
  try {
    await ensureChannels();
    let granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted && ask) granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return false;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api('/v1/me/device', { method: 'PATCH', body: { pushToken: token.data } });
    return true;
  } catch {
    return false;
  }
}

type Tap = (data: Record<string, string>) => void;

// Tells the server an alert reached the phone, so it does not also send an SMS,
// and routes a tap on the alert to the right screen.
export function listenForPushes(onTap: Tap): () => void {
  if (Platform.OS === 'web') return () => undefined;
  const received = Notifications.addNotificationReceivedListener((n) => {
    const data = n.request.content.data as Record<string, string>;
    if (data?.matchId) api(`/v1/matches/${data.matchId}/ack`, { body: { event: 'delivered' } }).catch(() => undefined);
  });
  const tapped = Notifications.addNotificationResponseReceivedListener((r) => {
    onTap(r.notification.request.content.data as Record<string, string>);
  });
  return () => {
    received.remove();
    tapped.remove();
  };
}

export const openBatterySettings = () => Linking.openSettings().catch(() => undefined);
export const dial = (phone: string) => Linking.openURL(`tel:${phone}`).catch(() => undefined);
