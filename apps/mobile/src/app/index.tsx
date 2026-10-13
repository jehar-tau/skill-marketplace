import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type Revise } from '../features/Composer';
import { ConversationsSheet, useConversations } from '../features/ConversationsSheet';
import { FindView } from '../features/FindView';
import { ProviderHome } from '../features/ProviderHome';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Card, Field, Sheet, Txt } from '../ui';

// Each person sees one side only: offering a service, or looking for help.
// The other side is a deliberate switch in settings, never a tab.
function Home({ role }: { role: 'find' | 'offer' }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, me, setMe } = useApp();
  const [chatsOpen, setChatsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [name, setName] = useState('');
  const [askName, setAskName] = useState(false);
  const [revise, setRevise] = useState<Revise | null>(null);
  const convs = useConversations();
  const unread = (convs.data ?? []).reduce((n, c) => n + c.unread, 0);

  // A name is asked for once there is someone to show it to, not during sign-up.
  const needName = !!me && !me.displayName && ((convs.data?.length ?? 0) > 0 || askName);

  const round = (label: string, icon: string, onPress: () => void, badge = 0) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: th.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: th.line }}>
      <Txt size={19}>{icon}</Txt>
      {badge > 0 ? (
        <View style={{ position: 'absolute', top: -2, right: -2, backgroundColor: th.warn, borderRadius: 9, minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={11} weight="700" color="#fff">{badge}</Txt>
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: th.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center', paddingTop: insets.top + 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <Txt size={22} weight="800" color={th.accent}>{role === 'offer' ? t.provTitle : t.findTitle}</Txt>
            {me?.displayName ? <Txt size={13} mute lines={1}>{me.displayName}</Txt> : null}
          </View>
          {round(t.chats, '💬', () => setChatsOpen(true), unread)}
          {round(t.settings, '⚙︎', () => router.push('/settings'))}
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
          {role === 'offer' ? <ProviderHome reloadKey={reloadKey} onNeedName={() => setAskName(true)} onEdit={setRevise} /> : <FindView reloadKey={reloadKey} />}
        </ScrollView>

        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: th.line, backgroundColor: th.bg }}>
          <Composer key={revise ? `${revise.id}:${revise.text}` : 'new'} purpose={role === 'offer' ? 'capability' : 'request'} revise={revise} onCancelRevise={() => setRevise(null)}
            onDone={() => { setRevise(null); setReloadKey((k) => k + 1); }} />
        </View>
      </View>

      <ConversationsSheet visible={chatsOpen} onClose={() => setChatsOpen(false)} list={convs.data ?? []} />
      <Sheet visible={needName} onClose={() => setAskName(false)} title={t.namePrompt}>
        <Field value={name} onChangeText={setName} placeholder={t.yourName} autoFocus maxLength={60} />
        <Btn label={t.save} disabled={name.trim().length < 1}
          onPress={async () => { setMe(await api('/v1/me', { method: 'PATCH', body: { displayName: name.trim() } })); setAskName(false); }} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

export default function Index() {
  const th = useTheme();
  const { ready, signedIn, me, role, roleChosen, setRole, t } = useApp();
  if (!ready) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: th.bg }}><ActivityIndicator color={th.accent} /></View>;
  if (!signedIn) return <Redirect href="/onboarding" />;
  if (!me) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: th.bg }}><ActivityIndicator color={th.accent} /></View>;
  // Anyone who signed in before the two sides were separated is asked once.
  if (!roleChosen) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: th.bg, width: '100%', maxWidth: 480, alignSelf: 'center' }}>
        <Txt size={28} weight="800" color={th.accent}>{t.roleTitle}</Txt>
        <Card onPress={() => setRole('offer')} style={{ borderColor: th.accent, borderWidth: 1.5, backgroundColor: th.accentSoft }}>
          <Txt size={19} weight="700" color={th.accent}>{t.roleOffer}</Txt>
          <Txt size={15}>{t.roleOfferSub}</Txt>
        </Card>
        <Card onPress={() => setRole('find')}>
          <Txt size={19} weight="700">{t.roleFind}</Txt>
          <Txt size={15} mute>{t.roleFindSub}</Txt>
        </Card>
      </View>
    );
  }
  return <Home key={`${me.id}-${role}`} role={role ?? 'offer'} />;
}
