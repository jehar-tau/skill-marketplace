import * as Linking from 'expo-linking';
import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, getDeviceId, platform, saveServerAddress } from '../lib/api';
import { apiUrl } from '../lib/config';
import { LOCALE_NAMES, type Locale } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, errorText, Field, Notice, Txt } from '../ui';

// A slow carousel of everyday talents, so people recognise themselves in one.
function Ideas({ width }: { width: number }) {
  const th = useTheme();
  const { t } = useApp();
  const [index, setIndex] = useState(0);
  const ref = useRef<ScrollView>(null);
  const touched = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (touched.current) return;
      setIndex((i) => {
        const next = (i + 1) % t.ideas.length;
        ref.current?.scrollTo({ x: next * width, animated: true });
        return next;
      });
    }, 3500);
    return () => clearInterval(timer);
  }, [t.ideas.length, width]);

  return (
    <View style={{ gap: 10 }}>
      <ScrollView ref={ref} horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ width }}
        onScrollBeginDrag={() => (touched.current = true)}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}>
        {t.ideas.map(([icon, title, line]) => (
          <View key={title} style={{ width, paddingRight: 2 }}>
            <View style={{ backgroundColor: th.accentSoft, borderRadius: 20, padding: 22, gap: 8, minHeight: 170, justifyContent: 'center' }}>
              <Txt size={40}>{icon}</Txt>
              <Txt size={21} weight="700">{title}</Txt>
              <Txt size={16} mute>{line}</Txt>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
        {t.ideas.map(([, title], i) => (
          <View key={title} style={{ width: i === index ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: i === index ? th.accent : th.line }} />
        ))}
      </View>
    </View>
  );
}

// Three short screens, one thing on each: the idea, your number, the code.
export default function Onboarding() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screen } = useWindowDimensions();
  const { t, locale, setLocale, signIn, signedIn } = useApp();
  const [step, setStep] = useState<'welcome' | 'phone' | 'code'>('welcome');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [pilot, setPilot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taps, setTaps] = useState(0);
  const [server, setServer] = useState(apiUrl());

  if (signedIn) return <Redirect href="/" />;
  const digits = phone.replace(/\D/g, '');
  const width = Math.min(screen, 480) - 48;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/v1/auth/otp/start', { body: { phone: digits }, auth: false });
      setDevCode(res.devCode ?? null);
      setPilot(!!res.pilot);
      setCode('');
      setStep('code');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value = code) {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/v1/auth/otp/verify', { body: { phone: digits, code: value, deviceId: await getDeviceId(), platform, locale }, auth: false });
      await signIn({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  const link = (label: string, path: string) => (
    <Pressable accessibilityRole="link" onPress={() => Linking.openURL(apiUrl() + path)}><Txt size={13} color={th.accent}>{label}</Txt></Pressable>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: th.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20, gap: 22, width: '100%', maxWidth: 480, alignSelf: 'center' }}>
        {step === 'welcome' ? (
          <>
            <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'flex-end' }}>
              {(Object.keys(LOCALE_NAMES) as Locale[]).map((l) => (
                <Pressable key={l} accessibilityRole="button" accessibilityState={{ selected: l === locale }} onPress={() => setLocale(l)}
                  style={{ paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: 18, backgroundColor: l === locale ? th.accentSoft : 'transparent' }}>
                  <Txt size={14} weight={l === locale ? '700' : '400'} color={l === locale ? th.accent : th.mute}>{LOCALE_NAMES[l]}</Txt>
                </Pressable>
              ))}
            </View>
            <View style={{ flex: 1, justifyContent: 'center', gap: 22 }}>
              <View style={{ gap: 10 }}>
                <Txt size={15} weight="700" color={th.accent}>{t.heroWhy}</Txt>
                <Pressable onPress={() => setTaps((n) => n + 1)} accessible={false}>
                  <Txt size={31} weight="800" style={{ lineHeight: 42 }}>{t.heroTitle}</Txt>
                </Pressable>
                <Txt size={17} mute>{t.heroSub}</Txt>
              </View>
              <Ideas width={width} />
            </View>
            {taps >= 5 ? (
              <View style={{ gap: 8 }}>
                <Field label="Server address (testers only)" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                <Btn small kind="plain" label="Use this server" onPress={async () => { await saveServerAddress(server.trim() || null); setTaps(0); }} />
              </View>
            ) : null}
            <View style={{ gap: 12 }}>
              <Btn label={t.getStarted} onPress={() => setStep('phone')} />
              <Txt size={13} mute style={{ textAlign: 'center' }}>{t.heroBusiness}</Txt>
            </View>
          </>
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', gap: 18 }}>
            <Txt size={26} weight="800">{step === 'phone' ? t.phonePrompt : pilot ? t.pilotPrompt : t.codePrompt}</Txt>
            {error ? <Notice text={error} tone="warn" /> : null}
            {step === 'phone' ? (
              <>
                <Field key="phone" value={phone} onChangeText={setPhone} placeholder={t.phoneHint} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={14} autoFocus
                  onSubmitEditing={() => digits.length >= 10 && start()} style={{ fontSize: 22 }} />
                <Btn label={t.sendCode} busy={busy} disabled={digits.length < 10} onPress={start} />
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <Txt size={13} mute>{t.freeLine}</Txt>
                  {link('Terms', '/legal/terms')}
                  {link('Privacy', '/legal/privacy')}
                </View>
              </>
            ) : (
              <>
                <Field key="code" value={code} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} autoFocus
                  onChangeText={(v) => { const c = v.replace(/\D/g, ''); setCode(c); if (c.length === 6 && !busy) void verify(c); }} style={{ letterSpacing: 8, fontSize: 26 }} />
                {devCode ? <Txt size={14} mute>{t.devCode}: {devCode}</Txt> : null}
                <Btn label={t.verify} busy={busy} disabled={code.length !== 6} onPress={() => verify()} />
                <Btn kind="plain" label={t.changeNumber} onPress={() => { setStep('phone'); setError(null); }} />
              </>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
