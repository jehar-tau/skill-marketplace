import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getLocales } from 'expo-localization';
import { api, loadTokens, saveTokens, setSignedOutHandler } from './lib/api';
import { STRINGS, type Locale } from './lib/i18n';
import { connectLive, disconnectLive, onLive, type LiveEvent } from './lib/realtime';
import { getItem, setItem } from './lib/storage';

export interface Me {
  id: string;
  displayName: string | null;
  preferredLocale: Locale;
  defaultView: 'find' | 'offer';
  phoneMasked: string;
  providerSettings: { paused: boolean; quietStart: string; quietEnd: string; dailyCap: number };
  udyam: string | null;
  device: { batteryExemptConfirmed: boolean; hasPush: boolean };
}

interface AppState {
  ready: boolean;
  signedIn: boolean;
  me: Me | null;
  locale: Locale;
  t: (typeof STRINGS)['en'];
  voiceInput: boolean;
  // Which side of the product this person uses. The two sides are kept apart on purpose.
  role: 'find' | 'offer' | null;
  // False until this device has been asked which side the person wants.
  roleChosen: boolean;
  setRole: (r: 'find' | 'offer') => Promise<void>;
  setLocale: (l: Locale) => void;
  signIn: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  signOut: () => Promise<void>;
  reloadMe: () => Promise<void>;
  setMe: (me: Me) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;

function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode;
  return code === 'mr' || code === 'hi' ? code : 'en';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [locale, setLocaleState] = useState<Locale>(deviceLocale());
  const [voiceInput, setVoiceInput] = useState(false);
  const [storedRole, setStoredRole] = useState<'find' | 'offer' | null>(null);

  const reloadMe = useCallback(async () => {
    const m = await api<Me>('/v1/me');
    setMe(m);
    setLocaleState(m.preferredLocale);
  }, []);

  const signOutLocal = useCallback(async () => {
    disconnectLive();
    await saveTokens(null);
    setMe(null);
    setSignedIn(false);
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => void signOutLocal());
    (async () => {
      const stored = (await getItem('locale')) as Locale | null;
      if (stored) setLocaleState(stored);
      const r = await getItem('role');
      if (r === 'find' || r === 'offer') setStoredRole(r);
      api('/v1/config', { auth: false }).then((c) => setVoiceInput(!!c.voiceInput)).catch(() => undefined);
      if (await loadTokens()) {
        setSignedIn(true);
        connectLive();
        // Offline at launch is fine: the session stays and data loads when the network returns.
        reloadMe().catch(() => undefined);
      }
      setReady(true);
    })();
  }, [reloadMe, signOutLocal]);

  const value = useMemo<AppState>(
    () => ({
      ready,
      signedIn,
      me,
      locale,
      t: STRINGS[locale],
      voiceInput,
      // For now the app is only for people offering a talent. The customer side stays
      // in the code and is switched on per device (storage key 'role' = 'find') for testing.
      role: storedRole === 'find' ? 'find' : 'offer',
      roleChosen: true,
      setRole: async (r) => {
        setStoredRole(r);
        await setItem('role', r);
        if (signedIn) await api('/v1/me', { method: 'PATCH', body: { defaultView: r } }).then(setMe).catch(() => undefined);
      },
      setMe,
      setLocale: (l) => {
        setLocaleState(l);
        void setItem('locale', l);
        if (signedIn) api('/v1/me', { method: 'PATCH', body: { preferredLocale: l } }).then(setMe).catch(() => undefined);
      },
      signIn: async (tokens) => {
        await saveTokens(tokens);
        setSignedIn(true);
        connectLive();
        await api('/v1/me', { method: 'PATCH', body: { preferredLocale: locale, defaultView: storedRole === 'find' ? 'find' : 'offer' } }).then(setMe);
      },
      signOut: async () => {
        await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
        await signOutLocal();
      },
      reloadMe,
    }),
    [ready, signedIn, me, locale, voiceInput, storedRole, reloadMe, signOutLocal],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Loads data, then keeps it fresh: on matching realtime hints, on reconnect, and
// on a slow timer in case a hint was missed.
export function useLive<T>(load: () => Promise<T>, on: LiveEvent['type'][], deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const types = on.join(',');

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e: any) {
      setError(e?.code ?? 'error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = onLive((e) => {
      if (e.type === 'resync' || types.split(',').includes(e.type)) void refresh();
    });
    const timer = setInterval(refresh, 30_000);
    return () => {
      off();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, types, ...deps]);

  return { data, error, refresh, setData };
}
