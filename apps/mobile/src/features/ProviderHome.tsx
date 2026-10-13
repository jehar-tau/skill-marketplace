import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { LOCALITIES } from '../lib/config';
import { currentPlace, enablePush, notificationsGranted, openBatterySettings, pushPossible, savePlace } from '../lib/device';
import { formatWhen } from '../lib/i18n';
import { getItem, setItem } from '../lib/storage';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { ProofSheet } from './ProofSheet';
import { Btn, Card, Chip, confirmAsk, Empty, errorText, Notice, Sheet, toast, TrustLine, Txt, type Trust } from '../ui';

interface Lead {
  matchId: string; state: string; open: boolean; requestText: string; deadlineAt: string | null; distanceKm: number;
  requesterName: string | null; requesterTrust: Trust; capabilityText: string; conversationId: string | null;
}
interface Service { id: string; status: string; originalText: string; categoryLabel: string; trust: Trust; proofLinks: number; proofPhotos: number }
interface Summary {
  activeSkills: number; leadsThisWeek: number; leadsTotal: number; replied: number; missed: number; jobsDone: number;
  ratingAvg: number | null; searching: boolean;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <Txt size={22} weight="800">{value}</Txt>
      <Txt size={12} mute style={{ textAlign: 'center' }}>{label}</Txt>
    </View>
  );
}

// The provider's side of the product: describe your work once, then watch leads arrive.
export function ProviderHome({ reloadKey, onNeedName, onEdit }: {
  reloadKey: number; onNeedName: () => void; onEdit: (r: { id: string; text: string }) => void;
}) {
  const th = useTheme();
  const { t, me, reloadMe } = useApp();
  const router = useRouter();
  const leads = useLive<Lead[]>(() => api('/v1/matches'), ['match'], [reloadKey]);
  const services = useLive<Service[]>(() => api('/v1/capabilities'), [], [reloadKey]);
  const summary = useLive<Summary>(() => api('/v1/provider/summary'), ['match', 'agreement'], [reloadKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(true);
  const [justLive, setJustLive] = useState(false);
  const [areaOpen, setAreaOpen] = useState(false);
  const [proofFor, setProofFor] = useState<string | null>(null);
  const [proofFirst, setProofFirst] = useState(false);
  const area = useLive<{ area: { serviceRadiusM: number } | null }>(() => api('/v1/provider/area'), [], [reloadKey]);

  async function saveArea(body: object) {
    try {
      area.setData(await api('/v1/provider/area', { method: 'PATCH', body }));
    } catch (e) {
      toast(errorText(e, t));
    }
  }
  const acked = useRef(new Set<string>());

  const count = services.data?.length ?? null;
  const hasService = (count ?? 0) > 0;

  // A talent tapped on the welcome screen is waiting in the box when they arrive.
  useEffect(() => {
    if (count !== 0) return;
    getItem('picked_talent').then((picked) => {
      if (!picked) return;
      void setItem('picked_talent', null);
      onEdit({ id: '', text: picked });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  useEffect(() => {
    if (!hasService) return;
    // The first time a service goes live, say clearly what happens next.
    getItem('seen_live').then((seen) => {
      if (!seen) {
        setJustLive(true);
        void setItem('seen_live', '1');
      }
    });
    // Alerts are asked for only once there is something to be alerted about.
    notificationsGranted().then((g) => {
      // Where the browser cannot do push at all, there is nothing to ask for.
      setPushOn(g || !pushPossible());
      if (g) void enablePush(false);
    });
  }, [hasService]);

  useEffect(() => {
    for (const m of leads.data ?? []) {
      if (m.state === 'notified' && !acked.current.has(m.matchId)) {
        acked.current.add(m.matchId);
        api(`/v1/matches/${m.matchId}/ack`, { body: { event: 'opened' } }).catch(() => undefined);
      }
    }
  }, [leads.data]);

  async function respond(m: Lead, action: 'interested' | 'declined') {
    setBusy(m.matchId);
    try {
      const res = await api(`/v1/matches/${m.matchId}/respond`, { body: { action } });
      await leads.refresh();
      void summary.refresh();
      if (res.conversationId) router.push(`/chat/${res.conversationId}`);
    } catch (e) {
      toast(errorText(e, t));
      await leads.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function patchService(id: string, status: 'active' | 'paused' | 'removed') {
    await api(`/v1/capabilities/${id}`, { method: 'PATCH', body: { status } }).catch(() => undefined);
    void services.refresh();
    void summary.refresh();
  }

  if (count === null) return null;

  // ---- First visit: one question, nothing else.
  if (!hasService) {
    return (
      <View style={{ gap: 16, paddingTop: 24 }}>
        <Txt size={30} weight="800" style={{ lineHeight: 40 }}>{t.welcomeTitle}</Txt>
        <Txt size={17} mute>{t.welcomeBody}</Txt>
        <Txt size={14} mute style={{ marginTop: 12 }}>{t.tryOne}</Txt>
        {t.starters.map((ex) => (
          <Card key={ex} onPress={() => onEdit({ id: '', text: ex })} style={{ backgroundColor: th.accentSoft, borderColor: 'transparent' }}>
            <Txt size={16}>{ex}</Txt>
          </Card>
        ))}
      </View>
    );
  }

  const s = summary.data;
  const openLeads = (leads.data ?? []).filter((m) => m.open);
  const answered = (leads.data ?? []).filter((m) => !m.open && m.conversationId).slice(0, 5);
  const showBattery = Platform.OS === 'android' && me && !me.device.batteryExemptConfirmed;

  return (
    <View style={{ gap: 12 }}>
      {/* Status: the standing promise, restated every time the app opens. */}
      <Card style={{ backgroundColor: s && !s.searching ? th.warnSoft : th.accentSoft, borderColor: 'transparent' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s && !s.searching ? th.warn : th.accent }} />
          <Txt size={17} weight="700" color={s && !s.searching ? th.warn : th.accent}>{s && !s.searching ? t.notSearching : t.searching}</Txt>
        </View>
        {!s || s.searching ? <Txt size={14}>{t.searchingSub}</Txt> : null}
        {s ? (
          <View style={{ flexDirection: 'row', marginTop: 6 }}>
            <Stat value={String(s.leadsThisWeek)} label={t.leadsWeek} />
            <Stat value={String(s.replied)} label={t.repliedStat} />
            <Stat value={String(s.jobsDone)} label={t.jobsStat} />
            <Stat value={s.ratingAvg === null ? '—' : `★ ${s.ratingAvg.toFixed(1)}`} label={t.ratingStat} />
          </View>
        ) : null}
      </Card>
      {s && s.missed > 0 ? <Notice tone="warn" text={t.missedNote(s.missed)} /> : null}

      {!pushOn ? (
        <Card>
          <Txt size={15}>{t.notifPrompt}</Txt>
          <Btn small label={t.notifEnable} onPress={async () => setPushOn(await enablePush(true))} />
        </Card>
      ) : null}
      {showBattery ? (
        <Card>
          <Txt size={16} weight="600">{t.battery}</Txt>
          <Txt size={14} mute>{t.batteryBody}</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small label={t.batteryOpen} onPress={openBatterySettings} />
            <Btn small kind="plain" label={t.batteryDone} onPress={async () => { await api('/v1/me/device', { method: 'PATCH', body: { batteryExemptConfirmed: true } }); void reloadMe(); }} />
          </View>
        </Card>
      ) : null}
      <Txt size={14} weight="600" mute style={{ marginTop: 4 }}>{t.leads}</Txt>
      {openLeads.length === 0 && answered.length === 0 ? <Empty text={t.noLeads} /> : null}
      {openLeads.map((m) => (
        <Card key={m.matchId} style={{ borderColor: th.accent, borderWidth: 1.5 }}>
          <Txt size={17} weight="600">{m.requestText}</Txt>
          <Txt size={14} mute>{t.away(m.distanceKm)}{m.deadlineAt ? ` · ${t.neededBy}: ${formatWhen(m.deadlineAt, t)}` : ''}</Txt>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {m.requesterName ? <Txt size={14}>{m.requesterName} ·</Txt> : null}
            <TrustLine trust={m.requesterTrust} />
          </View>
          <Txt size={13} mute lines={1}>{t.forSkill}: {m.capabilityText}</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn label={t.interested} busy={busy === m.matchId} onPress={() => respond(m, 'interested')} style={{ flex: 1 }} />
            <Btn kind="plain" label={t.notNow} disabled={busy === m.matchId} onPress={() => respond(m, 'declined')} />
          </View>
        </Card>
      ))}
      {answered.map((m) => (
        <Card key={m.matchId} onPress={() => router.push(`/chat/${m.conversationId}`)}>
          <Txt size={15} lines={2}>{m.requestText}</Txt>
          <Txt size={14} color={m.state === 'filled' ? th.mute : th.accent}>{m.state === 'filled' ? t.filled : `${t.openChat} →`}</Txt>
        </Card>
      ))}

      <Txt size={14} weight="600" mute style={{ marginTop: 6 }}>{t.myServices}</Txt>
      {(services.data ?? []).map((sv) => (
        <Card key={sv.id} style={{ opacity: sv.status === 'paused' ? 0.65 : 1 }}>
          <Txt size={13} mute>{sv.categoryLabel}{sv.status === 'paused' ? ` · ${t.paused}` : ''}</Txt>
          <Txt size={16}>{sv.originalText}</Txt>
          <TrustLine trust={sv.trust} />
          <Pressable accessibilityRole="button" onPress={() => { setProofFirst(false); setProofFor(sv.id); }} style={{ minHeight: 36, justifyContent: 'center' }}>
            <Txt size={14} color={th.accent} weight="600">{sv.proofLinks + sv.proofPhotos > 0 ? t.proofCount(sv.proofLinks, sv.proofPhotos) : t.proofAdd}</Txt>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small kind="plain" label={t.edit} onPress={() => onEdit({ id: sv.id, text: sv.originalText })} />
            <Btn small kind="plain" label={sv.status === 'paused' ? t.resume : t.pause} onPress={() => patchService(sv.id, sv.status === 'paused' ? 'active' : 'paused')} />
            <Btn small kind="plain" label={t.remove} onPress={() => confirmAsk(t.removeSkillConfirm, t.remove, t.cancel, () => patchService(sv.id, 'removed'))} />
          </View>
        </Card>
      ))}

      <Txt size={14} weight="600" mute style={{ marginTop: 6 }}>{t.yourArea}</Txt>
      <Card>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[3, 5, 10, 20].map((km) => (
            <Chip key={km} label={t.withinKm(km)} on={area.data?.area?.serviceRadiusM === km * 1000} onPress={() => saveArea({ serviceRadiusM: km * 1000 })} />
          ))}
        </View>
        <Btn small kind="plain" label={t.changeArea} onPress={() => setAreaOpen(true)} style={{ alignSelf: 'flex-start' }} />
      </Card>

      <Sheet visible={areaOpen} onClose={() => setAreaOpen(false)} title={t.whereAreYou}>
        <Txt size={14} mute>{t.whereWhy}</Txt>
        <Btn kind="soft" label={t.useMyLocation} onPress={async () => { const p = await currentPlace(); if (p) { await saveArea({ location: { lat: p.lat, lng: p.lng } }); setAreaOpen(false); toast(t.areaSaved); } }} />
        <Txt size={14} mute>{t.orPickArea}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {LOCALITIES.map((l) => (
            <Chip key={l.name} label={l.name} onPress={async () => { await savePlace({ lat: l.lat, lng: l.lng, label: l.name }); await saveArea({ location: { lat: l.lat, lng: l.lng } }); setAreaOpen(false); toast(t.areaSaved); }} />
          ))}
        </View>
      </Sheet>

      <ProofSheet capabilityId={proofFor} firstTime={proofFirst} onClose={() => { setProofFor(null); void services.refresh(); }} />

      <Sheet visible={justLive} onClose={() => setJustLive(false)} title={`✓ ${t.liveTitle}`}>
        <Txt size={17} weight="600" color={th.accent}>{t.liveBody}</Txt>
        <Txt size={16}>① {t.next1}</Txt>
        <Txt size={16}>② {t.next2}</Txt>
        <Txt size={16}>③ {t.next3}</Txt>
        <Btn label={t.gotIt} onPress={async () => {
          setJustLive(false);
          const first = services.data?.[0];
          if (first && !(await getItem('asked_proof'))) {
            void setItem('asked_proof', '1');
            setProofFirst(true);
            setProofFor(first.id);
          }
        }} />
      </Sheet>
    </View>
  );
}
