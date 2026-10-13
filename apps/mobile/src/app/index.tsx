import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type Revise } from '../features/Composer';
import { FindView } from '../features/FindView';
import { MessagesTab, useConversations } from '../features/MessagesTab';
import { ProviderHome } from '../features/ProviderHome';
import { ReviewPrompt } from '../features/ReviewPrompt';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Field, Sheet, Txt } from '../ui';

type Tab = 'profile' | 'find' | 'messages';

// Three places, always one tap away: your own profile, finding help, and messages.
function Home() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, me, setMe } = useApp();
  const [tab, setTab] = useState<Tab>('profile');
  const [reloadKey, setReloadKey] = useState(0);
  const [name, setName] = useState('');
  const [revise, setRevise] = useState<Revise | null>(null);
  const convs = useConversations();
  const unread = (convs.data ?? []).reduce((n, c) => n + c.unread, 0);

  // A name is asked for once there is someone to show it to, not during sign-up.
  const needName = !!me && !me.displayName && (convs.data?.length ?? 0) > 0;
  const title = tab === 'profile' ? t.tabProfile : tab === 'find' ? t.tabFind : t.tabMessages;

  const tabButton = (key: Tab, icon: string, label: string, badge = 0) => {
    const on = tab === key;
    return (
      <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={label} onPress={() => setTab(key)}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 56, gap: 2 }}>
        <View>
          <Txt size={22} style={{ opacity: on ? 1 : 0.45 }}>{icon}</Txt>
          {badge > 0 ? (
            <View style={{ position: 'absolute', top: -4, right: -12, backgroundColor: th.warn, borderRadius: 9, minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' }}>
              <Txt size={11} weight="700" color="#fff">{badge}</Txt>
            </View>
          ) : null}
        </View>
        <Txt size={12} weight={on ? '700' : '500'} color={on ? th.accent : th.mute}>{label}</Txt>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: th.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center', paddingTop: insets.top + 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <Txt size={24} weight="800">{title}</Txt>
            {tab === 'profile' && me?.displayName ? <Txt size={13} mute lines={1}>{me.displayName}</Txt> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t.settings} onPress={() => router.push('/settings')}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: th.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: th.line }}>
            <Txt size={18}>⚙︎</Txt>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
          {tab === 'profile' ? <ProviderHome reloadKey={reloadKey} onNeedName={() => undefined} onEdit={setRevise} />
            : tab === 'find' ? <FindView reloadKey={reloadKey} />
            : <MessagesTab list={convs.data ?? []} />}
        </ScrollView>

        {tab !== 'messages' ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderTopColor: th.line, backgroundColor: th.bg }}>
            <Composer key={`${tab}:${revise ? revise.id + revise.text : 'new'}`} purpose={tab === 'profile' ? 'capability' : 'request'}
              revise={tab === 'profile' ? revise : null} onCancelRevise={() => setRevise(null)}
              onDone={() => { setRevise(null); setReloadKey((k) => k + 1); }} />
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: th.line, backgroundColor: th.card, paddingBottom: insets.bottom }}>
          {tabButton('profile', '👤', t.tabProfile)}
          {tabButton('find', '🔍', t.tabFind)}
          {tabButton('messages', '💬', t.tabMessages, unread)}
        </View>
      </View>

      <ReviewPrompt />
      <Sheet visible={needName} onClose={() => undefined} title={t.namePrompt}>
        <Field value={name} onChangeText={setName} placeholder={t.yourName} autoFocus maxLength={60} />
        <Btn label={t.save} disabled={name.trim().length < 1}
          onPress={async () => setMe(await api('/v1/me', { method: 'PATCH', body: { displayName: name.trim() } }))} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

export default function Index() {
  const th = useTheme();
  const { ready, signedIn, me } = useApp();
  const wait = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: th.bg }}><ActivityIndicator color={th.accent} /></View>;
  if (!ready) return wait;
  if (!signedIn) return <Redirect href="/onboarding" />;
  if (!me) return wait;
  return <Home key={me.id} />;
}
