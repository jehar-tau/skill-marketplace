import * as ImagePicker from 'expo-image-picker';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgreementCard, type Agreement } from '../../features/AgreementCard';
import { api, newId } from '../../lib/api';
import { dial } from '../../lib/device';
import { onLive } from '../../lib/realtime';
import { getJson, setJson } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { useApp, useLive } from '../../state';
import { Btn, Chip, confirmAsk, errorText, Notice, Sheet, toast, TrustLine, Txt, type Trust } from '../../ui';

interface Msg {
  id: string; seq: number; kind: string; mine: boolean; body: string | null; meta: Record<string, any>;
  clientMessageId: string | null; createdAt: string;
}
interface Pending { clientMessageId: string; body: string }
interface Conv {
  id: string; status: string; role: 'requester' | 'provider'; other: { id: string; displayName: string | null; trust: Trust };
  requestText: string; requestStatus: string; lastSeq: number; theirReadSeq: number; iSharedNumber: boolean; blocked: boolean;
}

const REASONS = ['harassment', 'fraud', 'no_show', 'unsafe', 'spam', 'other'] as const;

function Photo({ assetId }: { assetId: string }) {
  const { t } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    // The photo becomes visible once the server has checked it and removed its metadata.
    const poll = async () => {
      const res = await api(`/v1/media/${assetId}`).catch(() => null);
      if (!alive) return;
      if (res?.thumbUrl) setUrl(res.url);
      else if (res?.state !== 'rejected' && tries++ < 10) setTimeout(poll, 1500);
    };
    void poll();
    return () => { alive = false; };
  }, [assetId]);
  if (!url) return <Txt size={14} mute>{t.photoChecking}</Txt>;
  return <Image source={{ uri: url }} style={{ width: 220, height: 220, borderRadius: 10 }} resizeMode="cover" accessibilityLabel={t.photo} />;
}

export default function Chat() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, ready, signedIn } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [reporting, setReporting] = useState(false);
  const lastSeq = useRef(0);
  const flushing = useRef(false);
  const listRef = useRef<FlatList<any>>(null);
  const outboxKey = `outbox.${id}`;

  const conv = useLive<Conv>(() => api(`/v1/conversations/${id}`), ['conversation', 'receipt', 'agreement'], [id]);
  const agreement = useLive<{ agreement: Agreement | null }>(() => api(`/v1/conversations/${id}/agreement`), ['agreement'], [id]);

  // Fetch only what is newer than what we hold; the socket merely says "there is more" (spec §11).
  const pull = useCallback(async () => {
    try {
      const fresh = await api<Msg[]>(`/v1/conversations/${id}/messages?after=${lastSeq.current}`);
      if (fresh.length === 0) return;
      lastSeq.current = fresh[fresh.length - 1]!.seq;
      setMessages((prev) => [...prev, ...fresh.filter((m) => !prev.some((p) => p.id === m.id))]);
      const done = new Set(fresh.map((m) => m.clientMessageId));
      setPending((p) => p.filter((x) => !done.has(x.clientMessageId)));
      api(`/v1/conversations/${id}/receipts`, { body: { readSeq: lastSeq.current } }).catch(() => undefined);
    } catch {
      // offline: the next hint or resync retries
    }
  }, [id]);

  // Messages written offline are kept on the device and sent, once each, when the network returns.
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const queue = await getJson<Pending[]>(outboxKey, []);
      for (const p of queue) {
        try {
          await api(`/v1/conversations/${id}/messages`, { body: { clientMessageId: p.clientMessageId, body: p.body } });
        } catch (e: any) {
          if (e?.code === 'offline') break;
          if (e?.code === 'blocked') toast(t.blockedNotice);
        }
        const rest = (await getJson<Pending[]>(outboxKey, [])).filter((x) => x.clientMessageId !== p.clientMessageId);
        await setJson(outboxKey, rest);
      }
      setPending(await getJson<Pending[]>(outboxKey, []));
      await pull();
    } finally {
      flushing.current = false;
    }
  }, [id, outboxKey, pull, t]);

  useEffect(() => {
    lastSeq.current = 0;
    setMessages([]);
    getJson<Pending[]>(outboxKey, []).then(setPending);
    void pull().then(flush);
    const off = onLive((e) => {
      if (e.type === 'resync') void flush();
      else if (e.type === 'message' && e.conversationId === id) void pull();
    });
    const timer = setInterval(flush, 20_000);
    return () => { off(); clearInterval(timer); };
  }, [id, outboxKey, pull, flush]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText('');
    const item = { clientMessageId: newId(), body };
    const queue = [...(await getJson<Pending[]>(outboxKey, [])), item];
    await setJson(outboxKey, queue);
    setPending(queue);
    void flush();
  }

  async function sendPhoto() {
    setMenu(false);
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      const asset = pick.assets?.[0];
      if (pick.canceled || !asset) return;
      const blob = await (await fetch(asset.uri)).blob();
      const mime = (asset.mimeType ?? blob.type ?? 'image/jpeg').split(';')[0]!;
      const up = await api('/v1/media', { body: { kind: 'image', mime, bytes: blob.size, conversationId: id } });
      const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': mime }, body: blob });
      if (!put.ok) throw new Error('upload');
      if (up.needsComplete) await api(`/v1/media/${up.assetId}/complete`, { method: 'POST' });
      await api(`/v1/conversations/${id}/messages`, { body: { clientMessageId: newId(), mediaAssetId: up.assetId } });
      await pull();
    } catch (e) {
      toast(errorText(e, t));
    }
  }

  const count = messages.length + pending.length;
  useEffect(() => {
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(timer);
  }, [count]);

  const c = conv.data;
  const other = c?.other.displayName ?? '—';
  const closed = !c || c.status !== 'open' || c.blocked;
  const rows: (Msg | (Pending & { pending: true }))[] = [...messages, ...pending.map((p) => ({ ...p, pending: true as const }))];

  function renderRow({ item }: { item: (typeof rows)[number] }) {
    if ('pending' in item) {
      return (
        <View style={{ alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: th.bubbleMine, opacity: 0.6, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, marginVertical: 3 }}>
          <Txt color={th.bubbleMineInk}>{item.body}</Txt>
          <Txt size={11} color={th.bubbleMineInk}>{t.sending}</Txt>
        </View>
      );
    }
    const m = item;
    if (m.kind === 'agreement' || m.kind === 'system') return null;
    if (m.kind === 'contact_share') {
      return (
        <View style={{ alignSelf: 'center', alignItems: 'center', gap: 6, backgroundColor: th.accentSoft, borderRadius: 14, padding: 12, marginVertical: 6 }}>
          <Txt size={14} color={th.accent}>{m.mine ? t.sharedNumberMine : `${other} ${t.sharedNumberTheirs}`}</Txt>
          {m.meta.phone ? (
            <>
              <Txt size={18} weight="700">{m.meta.phone}</Txt>
              {!m.mine ? <Btn small label={t.call} onPress={() => dial(m.meta.phone)} /> : null}
            </>
          ) : null}
        </View>
      );
    }
    const seen = m.mine && c && m.seq <= c.theirReadSeq;
    return (
      <View style={{ marginVertical: 3 }}>
        <View style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%', backgroundColor: m.mine ? th.bubbleMine : th.bubbleTheirs, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, borderWidth: m.mine ? 0 : 1, borderColor: th.line }}>
          {m.kind === 'image' && m.meta.mediaAssetId ? <Photo assetId={m.meta.mediaAssetId} /> : null}
          {m.body ? <Txt color={m.mine ? th.bubbleMineInk : th.ink}>{m.body}</Txt> : null}
          {seen ? <Txt size={11} color={th.bubbleMineInk} style={{ textAlign: 'right' }}>✓✓</Txt> : null}
        </View>
        {m.meta.scamWarning && !m.mine ? <View style={{ maxWidth: '90%', marginTop: 4 }}><Notice tone="warn" text={t.scamWarning} /></View> : null}
      </View>
    );
  }

  if (ready && !signedIn) return <Redirect href="/onboarding" />;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: th.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 4, borderBottomWidth: 1, borderBottomColor: th.line, backgroundColor: th.card }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t.back} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={24}>‹</Txt>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Txt size={17} weight="700" lines={1}>{other}</Txt>
            {c ? <TrustLine trust={c.other.trust} /> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Menu" onPress={() => setMenu(true)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={22}>⋮</Txt>
          </Pressable>
        </View>

        {c ? <View style={{ paddingHorizontal: 14, paddingTop: 8 }}><Txt size={13} mute lines={2}>“{c.requestText}”</Txt></View> : null}
        {c ? <AgreementCard conversationId={id} agreement={agreement.data?.agreement ?? null} canPropose={!closed} onChange={() => { void agreement.refresh(); void conv.refresh(); }} /> : null}

        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(m) => ('pending' in m ? m.clientMessageId : m.id)}
          renderItem={renderRow}
          contentContainerStyle={{ padding: 12 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        />

        {c?.blocked ? <View style={{ padding: 12 }}><Notice tone="warn" text={t.blockedNotice} /></View> : (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: th.line }}>
            <TextInput value={text} onChangeText={setText} placeholder={t.typeMessage} placeholderTextColor={th.mute} multiline editable={!closed} accessibilityLabel={t.typeMessage}
              style={{ flex: 1, backgroundColor: th.card, borderRadius: 22, borderWidth: 1, borderColor: th.line, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, lineHeight: 24, color: th.ink, maxHeight: 120 }} />
            <Pressable accessibilityRole="button" accessibilityLabel={t.send} disabled={!text.trim() || closed} onPress={send}
              style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: th.accent, alignItems: 'center', justifyContent: 'center', opacity: text.trim() && !closed ? 1 : 0.4 }}>
              <Txt size={20} weight="700" color={th.accentInk}>↑</Txt>
            </Pressable>
          </View>
        )}
      </View>

      <Sheet visible={menu} onClose={() => setMenu(false)}>
        {c && !c.iSharedNumber && !closed ? (
          <Btn label={t.shareNumber} onPress={() => { setMenu(false); confirmAsk(t.shareNumberConfirm, t.share, t.cancel, async () => { await api(`/v1/conversations/${id}/share-number`, { method: 'POST' }).catch((e) => toast(errorText(e, t))); void pull(); void conv.refresh(); }); }} />
        ) : null}
        {!closed ? <Btn kind="plain" label={t.photo} onPress={sendPhoto} /> : null}
        <Btn kind="plain" label={t.report} onPress={() => { setMenu(false); setReporting(true); }} />
        {c ? (
          <Btn kind="danger" label={c.blocked ? t.unblock : t.block}
            onPress={() => { setMenu(false); c.blocked
              ? api(`/v1/blocks/${c.other.id}`, { method: 'DELETE' }).then(() => conv.refresh())
              : confirmAsk(t.blockConfirm, t.block, t.cancel, async () => { await api('/v1/blocks', { body: { accountId: c.other.id } }); void conv.refresh(); }); }} />
        ) : null}
      </Sheet>
      <Sheet visible={reporting} onClose={() => setReporting(false)} title={t.reportWhy}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {REASONS.map((r) => (
            <Chip key={r} label={t[`r_${r}`]} onPress={async () => {
              setReporting(false);
              if (!c) return;
              await api('/v1/reports', { body: { subjectAccountId: c.other.id, conversationId: id, reason: r } }).then(() => toast(t.reportSent)).catch((e) => toast(errorText(e, t)));
            }} />
          ))}
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
