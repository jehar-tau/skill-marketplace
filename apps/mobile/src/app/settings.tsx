import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { LOCALE_NAMES, type Locale } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { Btn, Card, Chip, confirmAsk, errorText, Field, toast, Txt } from '../ui';

const QUIET: [string, string, string][] = [['22:00', '07:00', '10 PM – 7 AM'], ['23:00', '06:00', '11 PM – 6 AM'], ['00:00', '00:00', '—']];
const CAPS = [5, 10, 20, 50];

export default function Settings() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, me, setMe, locale, setLocale, signOut, signedIn, ready, role, setRole } = useApp();
  const [name, setName] = useState(me?.displayName ?? '');
  const [udyam, setUdyam] = useState('');
  const blocks = useLive<{ accountId: string; displayName: string | null }[]>(() => api('/v1/blocks'), [], []);

  useEffect(() => { if (ready && !signedIn) router.replace('/onboarding'); }, [ready, signedIn, router]);
  useEffect(() => { setName(me?.displayName ?? ''); }, [me?.displayName]);
  if (!me) return null;

  const patchMe = (body: object) => api('/v1/me', { method: 'PATCH', body }).then(setMe).catch((e) => toast(errorText(e, t)));
  const patchProvider = (body: object) => api('/v1/me/provider-settings', { method: 'PATCH', body }).then(setMe).catch((e) => toast(errorText(e, t)));
  const ps = me.providerSettings;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ width: '100%', maxWidth: 640, alignSelf: 'center', flex: 1 }}>
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t.back} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={24}>‹</Txt>
          </Pressable>
          <Txt size={20} weight="700">{t.settings}</Txt>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          <Card>
            <Field label={t.yourName} value={name} onChangeText={setName} maxLength={60} />
            <Txt size={14} mute>{me.phoneMasked}</Txt>
            {name.trim() && name.trim() !== (me.displayName ?? '') ? <Btn small label={t.save} onPress={() => patchMe({ displayName: name.trim() })} /> : null}
          </Card>

          <Card>
            <Txt size={14} mute>{t.language}</Txt>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {(Object.keys(LOCALE_NAMES) as Locale[]).map((l) => <Chip key={l} label={LOCALE_NAMES[l]} on={l === locale} onPress={() => setLocale(l)} />)}
            </View>
          </Card>

          {role === 'offer' ? (<>
          <Card>
            <Txt size={16} weight="600">{t.receiving}</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Txt>{t.pauseAll}</Txt>
              <Switch value={ps.paused} onValueChange={(v) => patchProvider({ paused: v })} accessibilityLabel={t.pauseAll} />
            </View>
            <Txt size={14} mute>{t.quietHours}</Txt>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {QUIET.map(([s, e, label]) => <Chip key={label} label={label} on={ps.quietStart === s && ps.quietEnd === e} onPress={() => patchProvider({ quietStart: s, quietEnd: e })} />)}
            </View>
            <Txt size={14} mute>{t.dailyCap}</Txt>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {CAPS.map((n) => <Chip key={n} label={String(n)} on={ps.dailyCap === n} onPress={() => patchProvider({ dailyCap: n })} />)}
            </View>
          </Card>

          <Card>
            <Txt size={16} weight="600">{t.udyam}</Txt>
            {me.udyam === 'verified' ? <Txt color={th.accent}>{t.registered} · {t.udyamVerified}</Txt> : me.udyam === 'submitted' ? <Txt mute>{t.udyamSubmitted}</Txt> : (
              <>
                <Txt size={14} mute>{t.udyamBody}</Txt>
                <Field value={udyam} onChangeText={(v) => setUdyam(v.toUpperCase())} placeholder={t.udyamHint} autoCapitalize="characters" maxLength={19} />
                <Btn small label={t.save} disabled={!/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(udyam)}
                  onPress={() => api('/v1/me/verification', { body: { kind: 'udyam', reference: udyam } }).then(() => api('/v1/me')).then(setMe).catch((e) => toast(errorText(e, t)))} />
              </>
            )}
          </Card>

          </>) : null}

          {blocks.data && blocks.data.length > 0 ? (
            <Card>
              <Txt size={16} weight="600">{t.blockedPeople}</Txt>
              {blocks.data.map((b) => (
                <View key={b.accountId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Txt>{b.displayName ?? '—'}</Txt>
                  <Btn small kind="plain" label={t.unblock} onPress={() => api(`/v1/blocks/${b.accountId}`, { method: 'DELETE' }).then(() => blocks.refresh())} />
                </View>
              ))}
            </Card>
          ) : null}

          <Btn kind="soft" label={role === 'offer' ? t.switchToFind : t.switchToOffer} onPress={async () => { await setRole(role === 'offer' ? 'find' : 'offer'); router.replace('/'); }} />
          <Btn kind="plain" label={t.signOut} onPress={signOut} />
          <Btn kind="danger" label={t.deleteAccount} onPress={() => confirmAsk(t.deleteConfirm, t.delete, t.cancel, async () => { await api('/v1/me', { method: 'DELETE' }).catch(() => undefined); await signOut(); })} />
        </ScrollView>
      </View>
    </View>
  );
}
