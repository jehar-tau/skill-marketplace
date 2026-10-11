import { Platform } from 'react-native';

// The Android emulator reaches the development machine at 10.0.2.2.
// Set EXPO_PUBLIC_API_URL for a real phone or a deployed server.
const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000');

// Testers can point an installed build at a different server (tap the title five
// times on the sign-in screen), so a new server address does not need a new build.
let override: string | null = null;
export const setApiUrlOverride = (url: string | null) => (override = url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : null);
export const apiUrl = () => override ?? DEFAULT_API_URL;
export const wsUrl = () => apiUrl().replace(/^http/, 'ws') + '/v1/ws';

// Typed-locality fallback when location permission is declined (spec §5.1).
export const LOCALITIES: { name: string; lat: number; lng: number }[] = [
  { name: 'Amanora / Hadapsar', lat: 18.5187, lng: 73.9348 },
  { name: 'Kothrud', lat: 18.5074, lng: 73.8077 },
  { name: 'Baner', lat: 18.559, lng: 73.7868 },
  { name: 'Aundh', lat: 18.558, lng: 73.8075 },
  { name: 'Viman Nagar', lat: 18.5679, lng: 73.9143 },
  { name: 'Kharadi', lat: 18.5515, lng: 73.9348 },
  { name: 'Wakad', lat: 18.5989, lng: 73.7653 },
  { name: 'Hinjawadi', lat: 18.5913, lng: 73.7389 },
  { name: 'Pimpri-Chinchwad', lat: 18.6298, lng: 73.7997 },
  { name: 'Shivajinagar / Deccan', lat: 18.5308, lng: 73.8475 },
  { name: 'Camp / Koregaon Park', lat: 18.5362, lng: 73.8939 },
  { name: 'Katraj / Dhankawadi', lat: 18.4575, lng: 73.8677 },
  { name: 'Sinhagad Road', lat: 18.4712, lng: 73.8193 },
  { name: 'Kondhwa / NIBM', lat: 18.4696, lng: 73.8906 },
  { name: 'Wagholi', lat: 18.5808, lng: 73.9787 },
];
