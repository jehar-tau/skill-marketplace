import { Redirect } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, getDeviceId, platform, saveServerAddress } from '../lib/api';
import * as Linking from 'expo-linking';
import { apiUrl } from '../lib/config';
import { LOCALE_NAMES, type Locale } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Card, Chip, errorText, Field, Notice, Txt } from '../ui';

// Phone number and code are the only fields (spec §5.1). Language is pre-selected from the device.
export default function Onboarding() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { t, locale, setLocale, signIn, signedIn, role, setRole } = useApp();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'role' | 'phone' | 'code'>(role ? 'phone' : 'role');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [pilot, setPilot] = useState(false);
  const [taps, setTaps] = useState(0);
  const [server, setServer] = useState(apiUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (signedIn) return <Redirect href="/" />;
  const digits = phone.replace(/\D/g, '');

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

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: th.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: insets.top + 24, gap: 18, width: '100%', maxWidth: 480, alignSelf: 'center' }}>
        <View style={{ gap: 4 }}>
          <Txt size={28} weight="800" color={th.accent}>{step === 'role' ? t.roleTitle : role === 'offer' ? t.provHeadline : t.findTitle}</Txt>
          <Pressable onPress={() => setTaps((n) => n + 1)} accessible={false}><Txt mute>{t.appName}</Txt></Pressable>
        </View>
        {taps >= 5 ? (
          <View style={{ gap: 8 }}>
            <Field label="Server address (testers only)" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <Btn small kind="plain" label="Use this server" onPress={async () => { await saveServerAddress(server.trim() || null); setTaps(0); }} />
          </View>
        ) : null}
        <View style={{ gap: 8 }}>
          <Txt size={14} mute>{t.chooseLanguage}</Txt>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(LOCALE_NAMES) as Locale[]).map((l) => <Chip key={l} label={LOCALE_NAMES[l]} on={l === locale} onPress={() => setLocale(l)} />)}
          </View>
        </View>
        {error ? <Notice text={error} tone="warn" /> : null}
        {step === 'role' ? (
          <>
            <Card onPress={async () => { await setRole('offer'); setStep('phone'); }} style={{ borderColor: th.accent, borderWidth: 1.5, backgroundColor: th.accentSoft }}>
              <Txt size={19} weight="700" color={th.accent}>{t.roleOffer}</Txt>
              <Txt size={15}>{t.roleOfferSub}</Txt>
            </Card>
            <Card onPress={async () => { await setRole('find'); setStep('phone'); }}>
              <Txt size={19} weight="700">{t.roleFind}</Txt>
              <Txt size={15} mute>{t.roleFindSub}</Txt>
            </Card>
          </>
        ) : step === 'phone' ? (
          <>
            {role === 'offer' ? (
              <View style={{ gap: 6 }}>
                <Txt size={16}>① {t.provPromise1}</Txt>
                <Txt size={16}>② {t.provPromise2}</Txt>
                <Txt size={16}>③ {t.provPromise3}</Txt>
                <Txt size={14} mute>{t.freeLine}</Txt>
              </View>
            ) : null}
            <Field key="phone" label={t.phonePrompt} value={phone} onChangeText={setPhone} placeholder={t.phoneHint} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={14} autoFocus onSubmitEditing={() => digits.length >= 10 && start()} />
            <Btn label={role === 'offer' ? t.getStarted : t.sendCode} busy={busy} disabled={digits.length < 10} onPress={start} />
            <Btn kind="plain" label={t.back} onPress={() => setStep('role')} />
          </>
        ) : (
          <>
            <Field key="code" label={pilot ? t.pilotPrompt : t.codePrompt} value={code} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} autoFocus
              onChangeText={(v) => { const c = v.replace(/\D/g, ''); setCode(c); if (c.length === 6 && !busy) void verify(c); }} style={{ letterSpacing: 6, fontSize: 22 }} />
            {devCode ? <Txt size={14} mute>{t.devCode}: {devCode}</Txt> : null}
            <Btn label={t.verify} busy={busy} disabled={code.length !== 6} onPress={() => verify()} />
            <Btn kind="plain" label={t.changeNumber} onPress={() => { setStep('phone'); setError(null); }} />
          </>
        )}
        <Txt size={13} mute>{t.terms}</Txt>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(apiUrl() + '/legal/terms')}><Txt size={13} color={th.accent}>Terms</Txt></Pressable>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(apiUrl() + '/legal/privacy')}><Txt size={13} color={th.accent}>Privacy</Txt></Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
