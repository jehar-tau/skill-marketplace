import type { ReactNode } from 'react';
import {
  ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './lib/theme';
import { useApp } from './state';

export function Txt({ children, size = 16, weight = '400', mute, color, style, lines }: {
  children: ReactNode; size?: number; weight?: TextStyle['fontWeight']; mute?: boolean; color?: string; style?: StyleProp<TextStyle>; lines?: number;
}) {
  const th = useTheme();
  // Devanagari needs more line height than Latin or its matras clip.
  return <Text numberOfLines={lines} style={[{ fontSize: size, lineHeight: Math.round(size * 1.5), fontWeight: weight, color: color ?? (mute ? th.mute : th.ink) }, style]}>{children}</Text>;
}

export function Btn({ label, onPress, kind = 'primary', busy, disabled, small, style }: {
  label: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger' | 'soft'; busy?: boolean; disabled?: boolean; small?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const th = useTheme();
  const bg = kind === 'primary' ? th.accent : kind === 'soft' ? th.accentSoft : 'transparent';
  const fg = kind === 'primary' ? th.accentInk : kind === 'danger' ? th.warn : kind === 'soft' ? th.accent : th.ink;
  const border = kind === 'plain' ? th.line : kind === 'danger' ? th.warn : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        { backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: 12, minHeight: small ? 40 : 48, paddingHorizontal: small ? 14 : 18, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: small ? 15 : 16, fontWeight: '600', textAlign: 'center' }}>{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const th = useTheme();
  const base: ViewStyle = { backgroundColor: th.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: th.line, padding: 14, gap: 8 };
  if (onPress) return <Pressable onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.85 : 1 }, style]}>{children}</Pressable>;
  return <View style={[base, style]}>{children}</View>;
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  const th = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!on }}
      style={{ paddingHorizontal: 14, minHeight: 40, justifyContent: 'center', borderRadius: 20, borderWidth: 1, borderColor: on ? th.accent : th.line, backgroundColor: on ? th.accentSoft : th.card }}>
      <Text style={{ color: on ? th.accent : th.ink, fontSize: 15, fontWeight: on ? '600' : '400' }}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const th = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {props.label ? <Txt size={14} mute>{props.label}</Txt> : null}
      <TextInput
        placeholderTextColor={th.mute}
        {...props}
        style={[{ borderWidth: 1, borderColor: th.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: th.ink, backgroundColor: th.card, minHeight: 48 }, props.style]}
      />
    </View>
  );
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: th.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%', paddingBottom: insets.bottom + 12, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
        <View style={{ alignItems: 'center', paddingTop: 8 }}><View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: th.line }} /></View>
        {title ? <Txt size={18} weight="700" style={{ paddingHorizontal: 18, paddingTop: 10 }}>{title}</Txt> : null}
        <ScrollView contentContainerStyle={{ padding: 18, gap: 12 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export interface Trust { registeredBusiness: boolean; completedJobs: number; ratingAvg: number | null; ratingCount: number; isNew: boolean }

// The one line of reputation a person sees about the other side (spec §8.3).
export function TrustLine({ trust }: { trust: Trust }) {
  const th = useTheme();
  const { t } = useApp();
  const parts: ReactNode[] = [];
  if (trust.registeredBusiness) parts.push(<Text key="r" style={{ color: th.accent, fontWeight: '600' }}>{t.registered}</Text>);
  if (trust.isNew) parts.push(<Text key="n">{t.newTag}</Text>);
  else parts.push(<Text key="j">{t.jobs(trust.completedJobs)}</Text>);
  if (trust.ratingAvg !== null) parts.push(<Text key="s" style={{ color: th.star, fontWeight: '600' }}>★ {trust.ratingAvg.toFixed(1)}</Text>);
  return (
    <Text style={{ fontSize: 14, color: th.mute, lineHeight: 21 }}>
      {parts.map((p, i) => [i > 0 ? ' · ' : '', p])}
    </Text>
  );
}

export function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' }) {
  const th = useTheme();
  return (
    <View style={{ backgroundColor: tone === 'warn' ? th.warnSoft : th.accentSoft, borderRadius: 12, padding: 12 }}>
      <Txt size={14} color={tone === 'warn' ? th.warn : th.accent}>{text}</Txt>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Txt mute size={15} style={{ paddingVertical: 8 }}>{text}</Txt>;
}

// Alert.alert has no buttons on web, so confirmations fall back to the browser dialog there.
export function confirmAsk(message: string, okLabel: string, cancelLabel: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(message)) onOk();
    return;
  }
  Alert.alert('', message, [{ text: cancelLabel, style: 'cancel' }, { text: okLabel, onPress: onOk }]);
}

export function toast(message: string) {
  if (Platform.OS === 'web') globalThis.alert?.(message);
  else Alert.alert('', message);
}

export function errorText(e: any, t: ReturnType<typeof useApp>['t']): string {
  switch (e?.code) {
    case 'offline': return t.offline;
    case 'rate_limited': case 'otp_attempts': return t.tooMany;
    case 'otp_invalid': return t.wrongCode;
    case 'otp_expired': return t.expiredCode;
    case 'asr_unavailable': case 'asr_empty': return t.voiceUnavailable;
    case 'deadline_passed': return t.deadlinePassed;
    case 'request_closed': case 'match_closed': return t.closed;
    case 'blocked': return t.blockedNotice;
    case 'not_invited': return t.notInvited;
    default: return t.error;
  }
}
