import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { LOCALITIES } from '../lib/config';
import { currentPlace, enablePush, notificationsGranted, openBatterySettings, pushPossible, savedPlace, savePlace } from '../lib/device';
import { formatWhen } from '../lib/i18n';
import { linkLabel } from '../lib/links';
import { getItem, setItem } from '../lib/storage';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { ProofSheet, Thumb } from './ProofSheet';
import { Btn, Card, Chip, confirmAsk, Empty, errorText, Field, Notice, Sheet, toast, TrustLine, Txt, type Trust } from '../ui';

interface Lead {
  matchId: string; state: string; open: boolean; requestText: string; deadlineAt: string | null; distanceKm: number;
  requesterName: string | null; requesterTrust: Trust; capabilityText: string; conversationId: string | null;
}
interface Proof { id: string; kind: 'link' | 'photo'; url: string | null; mediaAssetId: string | null }
interface Service {
  id: string; status: string; originalText: string; categoryLabel: string; trust: Trust; proofLinks: number; proofPhotos: number;
  proofs: Proof[]; experience: 'business' | 'informal' | 'new' | null; experienceNote: string | null;
}
interface Insight { id: string; capabilityId: string | null; kind: string; text: string }
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
export function ProviderHome({ reloadKey }: { reloadKey: number }) {
  const th = useTheme();
  const { t, me, reloadMe, setMe } = useApp();
  const router = useRouter();
  const leads = useLive<Lead[]>(() => api('/v1/matches'), ['match'], [reloadKey]);
  const services = useLive<Service[]>(() => api('/v1/capabilities'), [], [reloadKey]);
  const summary = useLive<Summary>(() => api('/v1/provider/summary'), ['match', 'agreement'], [reloadKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(true);
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState('');
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  const [areaOpen, setAreaOpen] = useState(false);
  const insights = useLive<Insight[]>(() => api('/v1/profile/insights'), ['agreement'], [reloadKey]);
  const [openLearned, setOpenLearned] = useState<string | null>(null);
  const [proofFor, setProofFor] = useState<string | null>(null);
  const area = useLive<{ area: { serviceRadiusM: number } | null }>(() => api('/v1/provider/area'), [], [reloadKey]);

  async function saveArea(body: object, label?: string | null) {
    try {
      area.setData(await api('/v1/provider/area', { method: 'PATCH', body }));
      if (label !== undefined) setPlaceLabel(label);
    } catch (e) {
      toast(errorText(e, t));
    }
  }
  const acked = useRef(new Set<string>());

  const count = services.data?.length ?? null;
  const hasService = (count ?? 0) > 0;

  useEffect(() => { savedPlace().then((p) => setPlaceLabel(p?.label ?? null)); }, [reloadKey]);

  // Someone with no business yet goes straight into the guided questions, once; a talent tapped
  // on the welcome screen is carried in as the first answer.
  useEffect(() => {
    if (count !== 0) return;
    getItem(`guided_opened:${me?.id}`).then(async (opened) => {
      if (opened) return;
      await setItem(`guided_opened:${me?.id}`, '1');
      const picked = await getItem('picked_talent');
      if (picked) await setItem('picked_talent', null);
      router.push(picked ? { pathname: '/add-business', params: { text: picked } } : '/add-business');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  useEffect(() => {
    if (!hasService) return;
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

  const s = summary.data;
  const openLeads = (leads.data ?? []).filter((m) => m.open);
  const answered = (leads.data ?? []).filter((m) => !m.open && m.conversationId).slice(0, 5);
  const showBattery = Platform.OS === 'android' && hasService && me && !me.device.batteryExemptConfirmed;
  const searching = !s || s.searching;
  const addBusiness = () => router.push('/add-business');
  const areaText = placeLabel ?? (area.data?.area ? t.areaNearYou : t.setArea);

  return (
    <View style={{ gap: 12 }}>
      {/* Who you are: only you see this. */}
      <Card>
        <Pressable accessibilityRole="button" onPress={() => { setName(me?.displayName ?? ''); setNameOpen(true); }} style={{ minHeight: 36, justifyContent: 'center' }}>
          <Txt size={22} weight="800" color={me?.displayName ? th.ink : th.accent}>{me?.displayName || t.addYourName}</Txt>
        </Pressable>
        <Txt size={15} mute>📞 {me?.phoneMasked}</Txt>
        <Pressable accessibilityRole="button" onPress={() => setAreaOpen(true)} style={{ minHeight: 32, justifyContent: 'center' }}>
          <Txt size={15} color={placeLabel || area.data?.area ? th.mute : th.accent}>📍 {areaText}{area.data?.area ? ` · ${t.withinKm(Math.round(area.data.area.serviceRadiusM / 1000))}` : ''}</Txt>
        </Pressable>
        {hasService ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: searching ? th.accent : th.warn }} />
            <Txt size={15} weight="700" color={searching ? th.accent : th.warn}>{searching ? t.searching : t.notSearching}</Txt>
          </View>
        ) : null}
      </Card>

      {s && s.missed > 0 ? <Notice tone="warn" text={t.missedNote(s.missed)} /> : null}
      {hasService && !pushOn ? (
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

      {/* Requests waiting for an answer come before everything else. */}
      {openLeads.length > 0 ? <Txt size={14} weight="600" mute style={{ marginTop: 4 }}>{t.leads}</Txt> : null}
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

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
        <Txt size={18} weight="800" style={{ flex: 1 }}>{t.myBusinesses}</Txt>
        {hasService ? <Btn small kind="soft" label={t.addBusiness} onPress={addBusiness} /> : null}
      </View>

      {!hasService ? (
        <Card style={{ backgroundColor: th.accentSoft, borderColor: 'transparent', gap: 10 }}>
          <Txt size={20} weight="800">{t.firstBusinessTitle}</Txt>
          <Txt size={16}>{t.firstBusinessBody}</Txt>
          <Btn label={t.firstBusinessBtn} onPress={addBusiness} />
        </Card>
      ) : null}

      {(services.data ?? []).map((sv) => {
        const photos = sv.proofs.filter((p) => p.kind === 'photo');
        const links = sv.proofs.filter((p) => p.kind === 'link');
        const mine = (insights.data ?? []).filter((i) => i.capabilityId === sv.id);
        const blurb = mine.find((i) => i.kind === 'summary');
        const facts = mine.filter((i) => i.kind !== 'summary');
        return (
          <Card key={sv.id} style={{ opacity: sv.status === 'paused' ? 0.65 : 1 }}>
            <Txt size={13} mute>{sv.categoryLabel}{sv.status === 'paused' ? ` · ${t.paused}` : ''}</Txt>
            <Txt size={17} weight="600">{sv.originalText}</Txt>
            {sv.experience ? <Txt size={14}>{t.expLabel[sv.experience]}</Txt> : null}
            {sv.experienceNote ? <Txt size={14} mute>“{sv.experienceNote}”</Txt> : null}
            <TrustLine trust={sv.trust} />
            {photos.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {photos.slice(0, 4).map((p) => <Thumb key={p.id} assetId={p.mediaAssetId!} size={64} />)}
                {photos.length > 4 ? <View style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: th.line, alignItems: 'center', justifyContent: 'center' }}><Txt size={15} weight="700">+{photos.length - 4}</Txt></View> : null}
              </View>
            ) : null}
            {links.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {links.map((l) => <Chip key={l.id} label={`🔗 ${linkLabel(l.url!)}`} onPress={() => void Linking.openURL(l.url!)} />)}
              </View>
            ) : null}
            {mine.length > 0 ? (
              <View style={{ gap: 6, backgroundColor: th.accentSoft, borderRadius: 12, padding: 12 }}>
                {blurb ? <Txt size={15}>{blurb.text}</Txt> : null}
                {facts.length > 0 ? (
                  <Pressable accessibilityRole="button" onPress={() => setOpenLearned(openLearned === sv.id ? null : sv.id)} style={{ minHeight: 32, justifyContent: 'center' }}>
                    <Txt size={13} weight="700" color={th.accent}>{t.learnedCount(facts.length)} {openLearned === sv.id ? '▴' : '▾'}</Txt>
                  </Pressable>
                ) : null}
                {openLearned === sv.id ? (
                  <>
                    {facts.map((f) => (
                      <View key={f.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                        <Txt size={14} style={{ flex: 1 }}>• {f.text}</Txt>
                        <Pressable accessibilityRole="button" accessibilityLabel={t.remove} hitSlop={8}
                          onPress={async () => { insights.setData((insights.data ?? []).filter((x) => x.id !== f.id)); await api(`/v1/profile/insights/${f.id}`, { method: 'DELETE' }).catch(() => undefined); }}
                          style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                          <Txt size={14} mute>✕</Txt>
                        </Pressable>
                      </View>
                    ))}
                    <Txt size={12} mute>{t.learnedNote}</Txt>
                  </>
                ) : null}
              </View>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => setProofFor(sv.id)} style={{ minHeight: 36, justifyContent: 'center' }}>
              <Txt size={14} color={th.accent} weight="600">{sv.proofLinks + sv.proofPhotos > 0 ? t.proofCount(sv.proofLinks, sv.proofPhotos) : t.proofAdd}</Txt>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small kind="plain" label={t.edit} onPress={() => router.push({ pathname: '/add-business', params: { edit: sv.id } })} />
              <Btn small kind="plain" label={sv.status === 'paused' ? t.resume : t.pause} onPress={() => patchService(sv.id, sv.status === 'paused' ? 'active' : 'paused')} />
              <Btn small kind="plain" label={t.remove} onPress={() => confirmAsk(t.removeSkillConfirm, t.remove, t.cancel, () => patchService(sv.id, 'removed'))} />
            </View>
          </Card>
        );
      })}

      {hasService && s ? (
        <Card>
          <View style={{ flexDirection: 'row' }}>
            <Stat value={String(s.leadsThisWeek)} label={t.leadsWeek} />
            <Stat value={String(s.replied)} label={t.repliedStat} />
            <Stat value={String(s.jobsDone)} label={t.jobsStat} />
            <Stat value={s.ratingAvg === null ? '—' : `★ ${s.ratingAvg.toFixed(1)}`} label={t.ratingStat} />
          </View>
        </Card>
      ) : null}

      {hasService ? (
        <>
          <Txt size={14} weight="600" mute style={{ marginTop: 6 }}>{t.pastLeads}</Txt>
          {answered.length === 0 && openLeads.length === 0 ? <Empty text={t.noLeads} /> : null}
          {answered.map((m) => (
            <Card key={m.matchId} onPress={() => router.push(`/chat/${m.conversationId}`)}>
              <Txt size={15} lines={2}>{m.requestText}</Txt>
              <Txt size={14} color={m.state === 'filled' ? th.mute : th.accent}>{m.state === 'filled' ? t.filled : `${t.openChat} →`}</Txt>
            </Card>
          ))}
        </>
      ) : null}

      <Sheet visible={nameOpen} onClose={() => setNameOpen(false)} title={t.yourName}>
        <Field value={name} onChangeText={setName} placeholder={t.yourName} autoFocus maxLength={60} />
        <Btn label={t.save} disabled={name.trim().length < 1} onPress={async () => {
          try {
            setMe(await api('/v1/me', { method: 'PATCH', body: { displayName: name.trim() } }));
            setNameOpen(false);
          } catch (e) {
            toast(errorText(e, t));
          }
        }} />
      </Sheet>

      <Sheet visible={areaOpen} onClose={() => setAreaOpen(false)} title={t.whereAreYou}>
        <Txt size={14} mute>{t.whereWhy}</Txt>
        <Btn kind="soft" label={t.useMyLocation} onPress={async () => { const p = await currentPlace(); if (p) { await savePlace(p); await saveArea({ location: { lat: p.lat, lng: p.lng } }, null); setAreaOpen(false); toast(t.areaSaved); } }} />
        <Txt size={14} mute>{t.orPickArea}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {LOCALITIES.map((l) => (
            <Chip key={l.name} label={l.name} on={placeLabel === l.name} onPress={async () => { await savePlace({ lat: l.lat, lng: l.lng, label: l.name }); await saveArea({ location: { lat: l.lat, lng: l.lng } }, l.name); setAreaOpen(false); toast(t.areaSaved); }} />
          ))}
        </View>
        {area.data?.area ? (
          <>
            <Txt size={14} mute>{t.howFar}</Txt>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {[3, 5, 10, 20].map((km) => (
                <Chip key={km} label={t.withinKm(km)} on={area.data?.area?.serviceRadiusM === km * 1000} onPress={() => saveArea({ serviceRadiusM: km * 1000 })} />
              ))}
            </View>
          </>
        ) : null}
      </Sheet>

      <ProofSheet capabilityId={proofFor} firstTime={false} onClose={() => { setProofFor(null); void services.refresh(); }} />
    </View>
  );
}
