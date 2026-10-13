import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { Card, Empty, TrustLine, Txt, type Trust } from '../ui';

export interface ConvSummary {
  id: string; role: 'requester' | 'provider'; other: { displayName: string | null }; requestText: string;
  lastText: string | null; unread: number;
}
interface Person {
  personId: string; displayName: string | null; relation: 'provider' | 'customer'; talent: string | null; trust: Trust; conversationId: string;
}

export const useConversations = () => useLive<ConvSummary[]>(() => api('/v1/conversations'), ['message', 'conversation', 'match', 'request'], []);

// All chats in one place. Colour says which side you are on in each: green when
// you are the one helping, indigo when someone is helping you.
export function MessagesTab({ list }: { list: ConvSummary[] }) {
  const th = useTheme();
  const { t } = useApp();
  const router = useRouter();
  const [view, setView] = useState<'chats' | 'people'>('chats');
  const people = useLive<Person[]>(() => api('/v1/people'), ['agreement', 'conversation'], []);

  const tone = (helping: boolean) => (helping ? { ink: th.accent, soft: th.accentSoft } : { ink: th.asCustomer, soft: th.asCustomerSoft });
  const seg = (key: 'chats' | 'people', label: string) => (
    <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: view === key }} onPress={() => setView(key)}
      style={{ flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: view === key ? th.card : 'transparent' }}>
      <Txt size={15} weight={view === key ? '700' : '500'} color={view === key ? th.ink : th.mute}>{label}</Txt>
    </Pressable>
  );

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', backgroundColor: th.line, borderRadius: 12, padding: 3 }}>
        {seg('chats', t.chatsTab)}
        {seg('people', t.peopleTab)}
      </View>

      {view === 'chats' ? (
        <>
          {list.length === 0 ? <Empty text={t.noChats} /> : null}
          {list.map((c) => {
            const helping = c.role === 'provider';
            const col = tone(helping);
            return (
              <Card key={c.id} onPress={() => router.push(`/chat/${c.id}`)} style={{ borderLeftWidth: 5, borderLeftColor: col.ink }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Txt size={17} weight="700" style={{ flex: 1 }} lines={1}>{c.other.displayName ?? '—'}</Txt>
                  {c.unread > 0 ? (
                    <View style={{ backgroundColor: col.ink, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
                      <Txt size={12} weight="700" color={th.card}>{c.unread}</Txt>
                    </View>
                  ) : null}
                </View>
                <View style={{ alignSelf: 'flex-start', backgroundColor: col.soft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Txt size={12} weight="700" color={col.ink}>{helping ? t.msgAsProvider : t.msgAsCustomer}</Txt>
                </View>
                <Txt size={15} mute lines={1}>{c.lastText ?? c.requestText}</Txt>
              </Card>
            );
          })}
        </>
      ) : (
        <>
          {people.data && people.data.length === 0 ? <Empty text={t.noPeople} /> : null}
          {(people.data ?? []).map((p) => {
            const col = tone(p.relation === 'customer');
            return (
              <Card key={p.personId} onPress={() => router.push(`/chat/${p.conversationId}`)} style={{ borderLeftWidth: 5, borderLeftColor: col.ink }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Txt size={17} weight="700" style={{ flex: 1 }} lines={1}>{p.displayName ?? '—'}</Txt>
                  <Pressable accessibilityRole="button" accessibilityLabel={t.removePersonLabel} hitSlop={8}
                    onPress={async () => { await api(`/v1/people/${p.personId}`, { method: 'DELETE' }).catch(() => undefined); void people.refresh(); }}
                    style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                    <Txt size={16} mute>✕</Txt>
                  </Pressable>
                </View>
                <View style={{ alignSelf: 'flex-start', backgroundColor: col.soft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Txt size={12} weight="700" color={col.ink}>{p.relation === 'provider' ? t.relProvider : t.relCustomer}</Txt>
                </View>
                {p.talent ? <Txt size={15} lines={2}>{p.talent}</Txt> : null}
                <TrustLine trust={p.trust} />
              </Card>
            );
          })}
        </>
      )}
    </View>
  );
}
