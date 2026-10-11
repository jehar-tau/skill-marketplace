import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { api } from '../lib/api';
import { formatWhen } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { Btn, Card, confirmAsk, Empty, TrustLine, Txt, type Trust } from '../ui';

interface Responder { matchId: string; conversationId: string; displayName: string | null; capabilityText: string; trust: Trust }
interface Req {
  id: string; status: string; originalText: string; categoryLabel: string; deadlineAt: string | null;
  notified: number; seen: number; interested: number; responders?: Responder[];
}

const OPEN = ['confirmed', 'dispatching', 'responded', 'no_match'];

export function FindView({ reloadKey }: { reloadKey: number }) {
  const th = useTheme();
  const { t } = useApp();
  const router = useRouter();
  const { data, refresh } = useLive<Req[]>(
    async () => {
      const list = await api<Req[]>('/v1/requests');
      // Requests with responders need their detail to show who can help.
      return Promise.all(list.map((r) => (r.interested > 0 && r.status !== 'cancelled' ? api<Req>(`/v1/requests/${r.id}`) : r)));
    },
    ['request'],
    [reloadKey],
  );

  function status(r: Req): string {
    switch (r.status) {
      case 'dispatching': return t.st_dispatching(r.notified, r.seen);
      case 'responded': return t.st_responded(r.interested);
      case 'no_match': return t.st_no_match;
      case 'agreed': return t.st_agreed;
      case 'completed': return t.st_completed;
      case 'cancelled': return t.st_cancelled;
      case 'expired': return t.st_expired;
      default: return t.st_confirmed;
    }
  }

  if (!data) return null;
  return (
    <View style={{ gap: 12 }}>
      <Txt size={14} weight="600" mute>{t.myRequests}</Txt>
      {data.length === 0 ? <Empty text={t.noRequests} /> : null}
      {data.map((r) => {
        const open = OPEN.includes(r.status);
        return (
          <Card key={r.id} style={{ opacity: open || r.status === 'agreed' ? 1 : 0.6 }}>
            <Txt size={17} weight="600">{r.originalText}</Txt>
            {r.deadlineAt ? <Txt size={14} mute>{t.neededBy}: {formatWhen(r.deadlineAt, t)}</Txt> : null}
            <Txt size={15} color={r.status === 'responded' || r.status === 'agreed' ? th.accent : th.mute}>{status(r)}</Txt>
            {(r.responders ?? []).map((p) => (
              <Card key={p.matchId} onPress={() => router.push(`/chat/${p.conversationId}`)} style={{ backgroundColor: th.accentSoft, borderColor: 'transparent' }}>
                <Txt size={16} weight="600">{p.displayName ?? '—'}</Txt>
                <Txt size={14} lines={2}>{p.capabilityText}</Txt>
                <TrustLine trust={p.trust} />
                <Txt size={15} weight="600" color={th.accent}>{t.openChat} →</Txt>
              </Card>
            ))}
            {open ? (
              <Btn small kind="plain" label={t.cancelRequest} style={{ alignSelf: 'flex-start' }}
                onPress={() => confirmAsk(t.cancelRequest + '?', t.yes, t.no, async () => { await api(`/v1/requests/${r.id}/cancel`, { method: 'POST' }).catch(() => undefined); void refresh(); })} />
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}
