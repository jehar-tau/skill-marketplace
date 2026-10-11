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

export async function notificationsGranted(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

// Requests permission, registers the device token with the server, and reports whether alerts will arrive.
export async function enablePush(ask: boolean): Promise<boolean> {
  if (Platform.OS === 'web') return false;
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
