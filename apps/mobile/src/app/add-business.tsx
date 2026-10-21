import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SpeakOrType } from '../features/SpeakOrType';
import { Thumb } from '../features/ProofSheet';
import { api } from '../lib/api';
import { LOCALITIES } from '../lib/config';
import { currentPlace, savedPlace, savePlace, type Place } from '../lib/device';
import { uploadImage } from '../lib/media';
import { linkKind, toLink, type LinkKind } from '../lib/links';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Card, Chip, errorText, Field, Notice, Txt } from '../ui';

interface Draft { interpretationId: string; categoryLabel: string; confirmationText: string }
interface Interpreted { originalText: string; drafts: Draft[]; needsClarification: string | null }
interface Proof { id: string; kind: 'link' | 'photo'; url: string | null; mediaAssetId: string | null }
interface Business { id: string; originalText: string; experience: Experience | null; experienceNote: string | null; proofs: Proof[] }
type Experience = 'business' | 'informal' | 'new';
type Step = 'what' | 'check' | 'experience' | 'where' | 'photos' | 'links' | 'done';

const STEP_NO: Record<Step, number> = { what: 1, check: 1, experience: 2, where: 2, photos: 3, links: 4, done: 4 };
const LINK_FIELDS: LinkKind[] = ['instagram', 'facebook', 'linkedin', 'other'];

// Adding a business, one question per screen (like listing a home on Airbnb). Every answer can be
// spoken or typed; only the first question is required. Also used to edit a business (?edit=id).
export default function AddBusiness() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, locale } = useApp();
  const params = useLocalSearchParams<{ edit?: string; text?: string }>();
  const editId = typeof params.edit === 'string' && params.edit ? params.edit : null;

  const [step, setStep] = useState<Step>('what');
  const [text, setText] = useState(typeof params.text === 'string' ? params.text : '');
  const [original, setOriginal] = useState<string | null>(null);
  const [result, setResult] = useState<Interpreted | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [experience, setExperience] = useState<Experience | null>(null);
  const [note, setNote] = useState('');
  const [capIds, setCapIds] = useState<string[]>(editId ? [editId] : []);
  // One photo is attached to every business described together; remember each copy so removal is complete.
  const [photos, setPhotos] = useState<{ assetId: string; proofIds: string[] }[]>([]);
  const [links, setLinks] = useState<Record<LinkKind, string>>({ instagram: '', facebook: '', linkedin: '', other: '' });
  const [savedLinks, setSavedLinks] = useState<Proof[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editing: start from what is already there.
  useEffect(() => {
    if (!editId) return;
    api<Business[]>('/v1/capabilities').then((all) => {
      const b = all.find((x) => x.id === editId);
      if (!b) return;
      setText(b.originalText);
      setOriginal(b.originalText);
      setExperience(b.experience);
      setNote(b.experienceNote ?? '');
      setPhotos(b.proofs.filter((p) => p.kind === 'photo').map((p) => ({ assetId: p.mediaAssetId!, proofIds: [p.id] })));
      const ls = b.proofs.filter((p) => p.kind === 'link');
      setSavedLinks(ls);
      const filled = { instagram: '', facebook: '', linkedin: '', other: '' };
      for (const l of ls) if (!filled[linkKind(l.url!)]) filled[linkKind(l.url!)] = l.url!;
      setLinks(filled);
    }).catch(() => undefined);
  }, [editId]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const go = (s: Step) => { setError(null); setStep(s); };
  const voiceError = () => setError(t.voiceUnavailable);

  async function understand() {
    if (editId && original !== null && text.trim() === original.trim()) return go('experience');
    setBusy(true);
    setError(null);
    try {
      const res = await api<Interpreted>('/v1/interpret', { body: { purpose: 'capability', locale, text: text.trim() } });
      if (res.drafts.length === 0 || res.needsClarification) return setError(t.notUnderstood);
      const drafts = editId ? res.drafts.slice(0, 1) : res.drafts;
      setResult({ ...res, drafts });
      setPicked(new Set(drafts.map((d) => d.interpretationId)));
      go('check');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const experiencePatch = () => ({ experience, experienceNote: note.trim() || null });

  async function afterExperience() {
    if (editId) {
      setBusy(true);
      try {
        if (result) await api(`/v1/capabilities/${editId}/revise`, { body: { interpretationId: result.drafts[0]!.interpretationId } });
        await api(`/v1/capabilities/${editId}`, { method: 'PATCH', body: experiencePatch() });
        go('photos');
      } catch (e) {
        setError(errorText(e, t));
      } finally {
        setBusy(false);
      }
      return;
    }
    const place = await savedPlace();
    if (place) await create(place);
    else go('where');
  }

  async function create(place: Place) {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await savePlace(place);
      for (const d of result.drafts.filter((x) => !picked.has(x.interpretationId))) {
        api(`/v1/interpretations/${d.interpretationId}/reject`, { method: 'POST' }).catch(() => undefined);
      }
      const res = await api<{ capabilityIds: string[] }>('/v1/capabilities/confirm', {
        body: { interpretationIds: [...picked], location: { lat: place.lat, lng: place.lng } },
      });
      setCapIds(res.capabilityIds);
      if (experience || note.trim()) {
        await Promise.all(res.capabilityIds.map((id) => api(`/v1/capabilities/${id}`, { method: 'PATCH', body: experiencePatch() })));
      }
      go('photos');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos() {
    setError(null);
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 8 });
      if (pick.canceled || !pick.assets?.length) return;
      setBusy(true);
      for (const asset of pick.assets) {
        const assetId = await uploadImage(asset.uri, asset.mimeType);
        const proofIds: string[] = [];
        for (const id of capIds) {
          const list = await api<Proof[]>(`/v1/capabilities/${id}/proofs`, { body: { mediaAssetId: assetId } });
          const mine = list.find((p) => p.mediaAssetId === assetId);
          if (mine) proofIds.push(mine.id);
        }
        setPhotos((p) => [...p, { assetId, proofIds }]);
      }
    } catch (e: any) {
      setError(e?.code === 'too_many_proofs' ? t.tooManyProofs : errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(assetId: string) {
    const p = photos.find((x) => x.assetId === assetId);
    setPhotos((all) => all.filter((x) => x.assetId !== assetId));
    for (const id of p?.proofIds ?? []) await api(`/v1/proofs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  async function saveLinks() {
    setBusy(true);
    setError(null);
    try {
      for (const kind of LINK_FIELDS) {
        const value = links[kind].trim();
        const before = savedLinks.filter((l) => linkKind(l.url!) === kind);
        if (before.some((l) => l.url === value)) continue;
        for (const l of before) await api(`/v1/proofs/${l.id}`, { method: 'DELETE' }).catch(() => undefined);
        if (!value) continue;
        for (const id of capIds) await api(`/v1/capabilities/${id}/proofs`, { body: { link: toLink(kind, value) } });
      }
      go('done');
    } catch (e: any) {
      setError(e?.code === 'bad_link' ? t.abBadLink : e?.code === 'too_many_proofs' ? t.tooManyProofs : errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  // Leaving before the business exists loses nothing that was saved; after that, everything is already stored.
  const back: Partial<Record<Step, Step>> = { check: 'what', experience: result ? 'check' : 'what', where: 'experience', links: 'photos' };
  const past = experience === 'business' || experience === 'informal';

  let body: React.ReactNode = null;
  if (step === 'what') {
    body = (
      <>
        <Txt size={28} weight="800" style={{ lineHeight: 38 }}>{t.abWhatTitle}</Txt>
        <Txt size={16} mute>{t.abWhatSub}</Txt>
        <SpeakOrType value={text} onChange={setText} placeholder={t.abWhatHint} onVoiceError={voiceError} autoFocus />
        {!text && !editId ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {t.starters.map((s) => <Chip key={s} label={s} onPress={() => setText(s)} />)}
          </View>
        ) : null}
        <Btn label={t.abNext} busy={busy} disabled={text.trim().length < 3} onPress={understand} />
      </>
    );
  } else if (step === 'check' && result) {
    const multi = result.drafts.length > 1;
    body = (
      <>
        <Txt size={28} weight="800">{t.abCheckTitle}</Txt>
        <Txt size={16} mute>{multi ? t.abCheckMany : t.abCheckSub}</Txt>
        {result.drafts.map((d) => {
          const on = picked.has(d.interpretationId);
          return (
            <Card key={d.interpretationId} style={{ borderColor: on ? th.accent : th.line, borderWidth: 1.5, opacity: on ? 1 : 0.55 }}
              onPress={multi ? () => setPicked((p) => { const n = new Set(p); n.has(d.interpretationId) ? n.delete(d.interpretationId) : n.add(d.interpretationId); return n; }) : undefined}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                {multi ? <Txt size={18} color={th.accent}>{on ? '☑' : '☐'}</Txt> : null}
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt size={13} mute>{d.categoryLabel}</Txt>
                  <Txt size={17}>{d.confirmationText}</Txt>
                </View>
              </View>
            </Card>
          );
        })}
        <Btn label={t.abYes} disabled={picked.size === 0} onPress={() => go('experience')} />
        <Btn kind="plain" label={t.editText} onPress={() => go('what')} />
      </>
    );
  } else if (step === 'experience') {
    const options: [Experience, string][] = [['business', t.abExpBusiness], ['informal', t.abExpInformal], ['new', t.abExpNew]];
    body = (
      <>
        <Txt size={28} weight="800">{t.abExpTitle}</Txt>
        {options.map(([key, label]) => (
          <Card key={key} onPress={() => setExperience(key)} style={{ borderColor: experience === key ? th.accent : th.line, borderWidth: 1.5 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Txt size={18} color={th.accent}>{experience === key ? '◉' : '○'}</Txt>
              <Txt size={17} style={{ flex: 1 }}>{label}</Txt>
            </View>
          </Card>
        ))}
        {experience ? (
          <>
            <Txt size={16} weight="600" style={{ marginTop: 8 }}>{t.abExpMoreTitle} <Txt size={14} mute>· {t.abOptional}</Txt></Txt>
            <SpeakOrType value={note} onChange={setNote} placeholder={experience === 'new' ? t.abExpMoreHintNew : t.abExpMoreHint} onVoiceError={voiceError} />
          </>
        ) : null}
        <Btn label={t.abNext} busy={busy} onPress={afterExperience} />
        {!experience ? <Btn kind="plain" label={t.abSkip} disabled={busy} onPress={afterExperience} /> : null}
      </>
    );
  } else if (step === 'where') {
    body = (
      <>
        <Txt size={28} weight="800">{t.whereAreYou}</Txt>
        <Txt size={16} mute>{t.whereWhy}</Txt>
        <Btn kind="soft" label={t.useMyLocation} busy={busy} onPress={async () => { const p = await currentPlace(); if (p) void create(p); else setError(t.locationUnavailable); }} />
        <Txt size={14} mute>{t.orPickArea}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {LOCALITIES.map((l) => <Chip key={l.name} label={l.name} onPress={() => void create({ lat: l.lat, lng: l.lng, label: l.name })} />)}
        </View>
      </>
    );
  } else if (step === 'photos') {
    body = (
      <>
        <Txt size={28} weight="800" style={{ lineHeight: 38 }}>{past ? t.abPhotosTitlePast : t.abPhotosTitleNew}</Txt>
        <Txt size={16} mute>{past ? t.abPhotosSubPast : t.abPhotosSubNew}</Txt>
        {photos.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {photos.map((p) => (
              <View key={p.assetId}>
                <Thumb assetId={p.assetId} size={96} />
                <Pressable accessibilityRole="button" accessibilityLabel={t.remove} onPress={() => removePhoto(p.assetId)}
                  style={{ position: 'absolute', top: 4, right: 4, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
                  <Txt size={13} color="#fff">✕</Txt>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <Btn kind="soft" label={photos.length ? t.abAddMorePhotos : t.addPhotos} busy={busy} onPress={addPhotos} />
        <Btn label={photos.length ? t.abNext : t.abSkip} kind={photos.length ? 'primary' : 'plain'} disabled={busy} onPress={() => go('links')} />
      </>
    );
  } else if (step === 'links') {
    const labels: Record<LinkKind, [string, string]> = {
      instagram: [t.abInstagram, t.abHandleHint], facebook: [t.abFacebook, t.abHandleHint], linkedin: [t.abLinkedIn, t.abLinkHint], other: [t.abWebsite, t.abLinkHint],
    };
    const any = LINK_FIELDS.some((k) => links[k].trim());
    body = (
      <>
        <Txt size={28} weight="800">{t.abLinksTitle}</Txt>
        <Txt size={16} mute>{t.abLinksSub}</Txt>
        {LINK_FIELDS.map((k) => (
          <Field key={k} label={labels[k][0]} value={links[k]} onChangeText={(v) => setLinks((l) => ({ ...l, [k]: v }))}
            placeholder={labels[k][1]} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        ))}
        <Btn label={any ? t.abNext : t.abSkip} kind={any ? 'primary' : 'plain'} busy={busy} onPress={saveLinks} />
      </>
    );
  } else if (step === 'done') {
    body = (
      <>
        <Txt size={44}>✓</Txt>
        <Txt size={28} weight="800">{editId ? t.abSavedTitle : t.abDoneTitle}</Txt>
        {!editId ? (
          <>
            <Txt size={17} weight="600" color={th.accent}>{t.liveBody}</Txt>
            <Txt size={16}>① {t.next1}</Txt>
            <Txt size={16}>② {t.next2}</Txt>
            <Txt size={16}>③ {t.next3}</Txt>
          </>
        ) : null}
        <Btn label={t.abSeeProfile} onPress={close} />
      </>
    );
  }

  const prev = back[step];
  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ width: '100%', maxWidth: 640, alignSelf: 'center', flex: 1 }}>
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {prev ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t.back} onPress={() => go(prev)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Txt size={24}>‹</Txt>
            </Pressable>
          ) : <View style={{ width: 44 }} />}
          <Txt size={14} mute style={{ flex: 1, textAlign: 'center' }}>{step === 'done' ? '' : t.abStep(STEP_NO[step], 4)}</Txt>
          <Pressable accessibilityRole="button" accessibilityLabel={t.abClose} onPress={close} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={20} mute>✕</Txt>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
          {error ? <Notice tone="warn" text={error} /> : null}
          {body}
        </ScrollView>
      </View>
    </View>
  );
}
