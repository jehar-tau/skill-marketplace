import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { Card, Empty, Sheet, Txt } from '../ui';

export interface ConvSummary {
  id: string; role: 'requester' | 'provider'; other: { displayName: string | null }; requestText: string;
  lastText: string | null; unread: number;
}

export const useConversations = () => useLive<ConvSummary[]>(() => api('/v1/conversations'), ['message', 'conversation', 'match', 'request'], []);

// Reachable from both views; deliberately a drawer, not a third destination (spec §1).
export function ConversationsSheet({ visible, onClose, list }: { visible: boolean; onClose: () => void; list: ConvSummary[] }) {
  const th = useTheme();
  const { t } = useApp();
  const router = useRouter();
  return (
    <Sheet visible={visible} onClose={onClose} title={t.chats}>
      {list.length === 0 ? <Empty text={t.noChats} /> : null}
      {list.map((c) => (
        <Card key={c.id} onPress={() => { onClose(); router.push(`/chat/${c.id}`); }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Txt size={16} weight="600" style={{ flex: 1 }} lines={1}>{c.other.displayName ?? '—'}</Txt>
            {c.unread > 0 ? (
              <View style={{ backgroundColor: th.accent, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={12} weight="700" color={th.accentInk}>{c.unread}</Txt>
              </View>
            ) : null}
          </View>
          <Txt size={13} mute lines={1}>{c.requestText}</Txt>
          {c.lastText ? <Txt size={15} lines={1}>{c.lastText}</Txt> : null}
        </Card>
      ))}
    </Sheet>
  );
}
