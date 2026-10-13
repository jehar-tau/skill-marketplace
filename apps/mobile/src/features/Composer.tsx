import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { currentPlace, savedPlace, savePlace, type Place } from '../lib/device';
import { LOCALITIES } from '../lib/config';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Card, Chip, errorText, Notice, Sheet, Txt } from '../ui';

interface Draft { interpretationId: string; categoryLabel: string; confirmationText: string }
interface Interpreted { originalText: string; drafts: Draft[]; needsClarification: string | null }

async function uploadClip(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const mime = (blob.type || (Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4')).split(';')[0]!;
  const up = await api('/v1/media', { body: { kind: 'audio', mime, bytes: blob.size } });
  const res = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': mime }, body: blob });
  if (!res.ok) throw Object.assign(new Error('upload'), { code: 'asr_unavailable' });
  if (up.needsComplete) await api(`/v1/media/${up.assetId}/complete`, { method: 'POST' });
  return up.assetId;
}

// The single input for both views: type or speak, then approve what was understood (spec §5.1, §10).
export interface Revise { id: string; text: string }

export function Composer({ purpose, onDone, revise, onCancelRevise }: {
  purpose: 'request' | 'capability'; onDone: () => void; revise?: Revise | null; onCancelRevise?: () => void;
}) {
  const th = useTheme();
  const { t, locale, voiceInput } = useApp();
  const [text, setText] = useState(revise?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Interpreted | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [askPlace, setAskPlace] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  // Browsers only allow the microphone on https pages (and localhost).
  const canRecord = Platform.OS !== 'web' || (globalThis as { isSecureContext?: boolean }).isSecureContext !== false;

  async function interpret(body: { text?: string; audioAssetId?: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Interpreted>('/v1/interpret', { body: { purpose, locale, ...body } });
      if (res.drafts.length === 0 || res.needsClarification) {
        setError(res.needsClarification === 'deadline_passed' ? t.deadlinePassed : t.notUnderstood);
        if (res.originalText) setText(res.originalText);
        return;
      }
      setResult(res);
      setPicked(new Set(res.drafts.map((d) => d.interpretationId)));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    setError(null);
    try {
      if (!recording) {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) return setError(t.voiceUnavailable);
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        setRecording(true);
        // Clips are capped at 60 seconds.
        setTimeout(() => recorder.isRecording && void stop(), 60_000);
      } else {
        await stop();
      }
    } catch {
      setRecording(false);
      setError(t.voiceUnavailable);
    }
  }

  async function stop() {
    setRecording(false);
    await recorder.stop();
    if (!recorder.uri) return setError(t.voiceUnavailable);
    setBusy(true);
    try {
      await interpret({ audioAssetId: await uploadClip(recorder.uri) });
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  async function confirm(place?: Place) {
    if (!result) return;
    if (revise) {
      setConfirming(true);
      try {
        const chosen = result.drafts.find((d) => picked.has(d.interpretationId)) ?? result.drafts[0]!;
        await api(`/v1/capabilities/${revise.id}/revise`, { body: { interpretationId: chosen.interpretationId } });
        setResult(null);
        setText('');
        onDone();
      } catch (e) {
        setError(errorText(e, t));
        setResult(null);
      } finally {
        setConfirming(false);
      }
      return;
    }
    const where = place ?? (await savedPlace()) ?? (await currentPlace());
    if (!where) return setAskPlace(true);
    setAskPlace(false);
    setConfirming(true);
    try {
      const location = { lat: where.lat, lng: where.lng };
      if (purpose === 'request') {
        await api('/v1/requests/confirm', { body: { interpretationId: result.drafts[0]!.interpretationId, location } });
      } else {
        const rejected = result.drafts.filter((d) => !picked.has(d.interpretationId));
        for (const d of rejected) api(`/v1/interpretations/${d.interpretationId}/reject`, { method: 'POST' }).catch(() => undefined);
        await api('/v1/capabilities/confirm', { body: { interpretationIds: [...picked], location } });
      }
      setResult(null);
      setText('');
      onDone();
    } catch (e) {
      setError(errorText(e, t));
      setResult(null);
    } finally {
      setConfirming(false);
    }
  }

  const canSend = text.trim().length > 1 && !busy;
  return (
    <View style={{ gap: 8 }}>
      {revise ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}><Notice text={t.editingService} /></View>
          <Btn small kind="plain" label={t.cancel} onPress={() => onCancelRevise?.()} />
        </View>
      ) : null}
      {error ? <Notice text={error} tone="warn" /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: th.card, borderRadius: 26, borderWidth: 1, borderColor: recording ? th.warn : th.line, paddingLeft: 16, paddingRight: 6, paddingVertical: 6 }}>
        <TextInput
          value={recording ? t.listening : text}
          editable={!recording && !busy}
          onChangeText={setText}
          placeholder={purpose === 'request' ? t.needPlaceholder : t.offerPlaceholder}
          placeholderTextColor={th.mute}
          multiline
          accessibilityLabel={purpose === 'request' ? t.needPlaceholder : t.offerPlaceholder}
          style={{ flex: 1, fontSize: 17, lineHeight: 25, color: recording ? th.warn : th.ink, maxHeight: 120, paddingVertical: 8, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
        />
        {busy ? (
          <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={th.accent} /></View>
        ) : canSend ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t.send} onPress={() => interpret({ text: text.trim() })}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: th.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={20} weight="700" color={th.accentInk}>↑</Txt>
          </Pressable>
        ) : voiceInput && canRecord ? (
          <Pressable accessibilityRole="button" accessibilityLabel={recording ? t.listening : t.holdToTalk} onPress={toggleRecording}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: recording ? th.warn : th.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={18} color={recording ? '#fff' : th.accent}>{recording ? '■' : '🎤'}</Txt>
          </Pressable>
        ) : null}
      </View>
      {!text && !recording && !busy ? <Txt size={13} mute style={{ paddingHorizontal: 8 }}>{purpose === 'request' ? t.needExample : t.offerExample}</Txt> : null}

      <Sheet visible={!!result && !askPlace} onClose={() => setResult(null)}>
        {result ? (
          <>
            <Txt size={13} mute>{t.youSaid}</Txt>
            <Txt size={16} style={{ fontStyle: 'italic' }}>“{result.originalText}”</Txt>
            {result.drafts.map((d) => {
              const on = picked.has(d.interpretationId);
              const multi = purpose === 'capability' && result.drafts.length > 1;
              return (
                <Card key={d.interpretationId} style={{ borderColor: on ? th.accent : th.line, borderWidth: 1.5, opacity: on ? 1 : 0.55 }}
                  onPress={multi ? () => setPicked((p) => { const n = new Set(p); n.has(d.interpretationId) ? n.delete(d.interpretationId) : n.add(d.interpretationId); return n; }) : undefined}>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    {multi ? <Txt size={18} color={th.accent}>{on ? '☑' : '☐'}</Txt> : null}
                    <Txt size={17} style={{ flex: 1 }}>{d.confirmationText}</Txt>
                  </View>
                </Card>
              );
            })}
            <Btn label={revise ? t.saveChange : purpose === 'request' ? t.confirmNeed : picked.size > 1 ? t.confirmOfferMany : t.confirmOffer} busy={confirming} disabled={picked.size === 0} onPress={() => confirm()} />
            <Btn kind="plain" label={t.editText} onPress={() => { setText(result.originalText); setResult(null); }} />
          </>
        ) : null}
      </Sheet>

      <Sheet visible={askPlace} onClose={() => setAskPlace(false)} title={t.whereAreYou}>
        <Txt size={14} mute>{t.whereWhy}</Txt>
        <Btn kind="soft" label={t.useMyLocation} onPress={async () => { const p = await currentPlace(); if (p) void confirm(p); }} />
        <Txt size={14} mute>{t.orPickArea}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {LOCALITIES.map((l) => (
            <Chip key={l.name} label={l.name} onPress={async () => { const p = { lat: l.lat, lng: l.lng, label: l.name }; await savePlace(p); void confirm(p); }} />
          ))}
        </View>
      </Sheet>
    </View>
  );
}
