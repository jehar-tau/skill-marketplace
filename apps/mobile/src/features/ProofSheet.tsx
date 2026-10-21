import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { mediaUrl } from '../lib/config';
import { uploadImage } from '../lib/media';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, errorText, Field, Notice, Sheet, Txt } from '../ui';

interface Proof { id: string; kind: 'link' | 'photo'; url: string | null; mediaAssetId: string | null }

export function Thumb({ assetId, size = 84 }: { assetId: string; size?: number }) {
  const th = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    // A photo shows once the server has checked it and removed its hidden details (such as location).
    const poll = async () => {
      const res = await api(`/v1/media/${assetId}`).catch(() => null);
      if (!alive) return;
      if (res?.thumbUrl) setUrl(mediaUrl(res.thumbUrl));
      else if (res?.state !== 'rejected' && tries++ < 12) setTimeout(poll, 1500);
    };
    void poll();
    return () => { alive = false; };
  }, [assetId]);
  return url ? <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: 12 }} /> : <View style={{ width: size, height: size, borderRadius: 12, backgroundColor: th.line }} />;
}

// Optional proof of work for one talent. Always skippable, and worded so that
// having nothing to show yet never feels like a failure.
export function ProofSheet({ capabilityId, firstTime, onClose }: { capabilityId: string | null; firstTime: boolean; onClose: () => void }) {
  const th = useTheme();
  const { t } = useApp();
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<'link' | 'photo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProofs([]);
    setLink('');
    setError(null);
    if (capabilityId) api<Proof[]>(`/v1/capabilities/${capabilityId}/proofs`).then(setProofs).catch(() => undefined);
  }, [capabilityId]);

  async function addLink() {
    if (!capabilityId || !link.trim()) return;
    setBusy('link');
    setError(null);
    try {
      setProofs(await api(`/v1/capabilities/${capabilityId}/proofs`, { body: { link: link.trim() } }));
      setLink('');
    } catch (e: any) {
      setError(e?.code === 'bad_link' ? t.proofBadLink : errorText(e, t));
    } finally {
      setBusy(null);
    }
  }

  async function addPhotos() {
    if (!capabilityId) return;
    setError(null);
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 6 });
      if (pick.canceled || !pick.assets?.length) return;
      setBusy('photo');
      let latest = proofs;
      for (const asset of pick.assets) {
        const assetId = await uploadImage(asset.uri, asset.mimeType);
        latest = await api(`/v1/capabilities/${capabilityId}/proofs`, { body: { mediaAssetId: assetId } });
        setProofs(latest);
      }
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setProofs((p) => p.filter((x) => x.id !== id));
    await api(`/v1/proofs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  const photos = proofs.filter((p) => p.kind === 'photo');
  const links = proofs.filter((p) => p.kind === 'link');
  return (
    <Sheet visible={!!capabilityId} onClose={onClose} title={t.proofTitle}>
      <Txt size={16} mute>{t.proofBody}</Txt>
      {error ? <Notice tone="warn" text={error} /> : null}

      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field value={link} onChangeText={setLink} placeholder={t.proofLinkHint} autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={addLink} />
        </View>
        <Btn label={t.addLink} kind="soft" busy={busy === 'link'} disabled={!link.trim()} onPress={addLink} />
      </View>
      {links.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Txt size={15} color={th.accent} lines={1} style={{ flex: 1 }}>{p.url?.replace(/^https?:\/\//, '')}</Txt>
          <Pressable accessibilityRole="button" accessibilityLabel={t.remove} onPress={() => remove(p.id)} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Txt size={18} mute>✕</Txt>
          </Pressable>
        </View>
      ))}

      <Btn kind="plain" label={t.addPhotos} busy={busy === 'photo'} onPress={addPhotos} />
      {photos.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {photos.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={t.remove} onLongPress={() => remove(p.id)}>
              <Thumb assetId={p.mediaAssetId!} />
              <Pressable onPress={() => remove(p.id)} style={{ position: 'absolute', top: 2, right: 2, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={13} color="#fff">✕</Txt>
              </Pressable>
            </Pressable>
          ))}
        </View>
      ) : null}

      {proofs.length > 0 ? <Txt size={13} mute>{t.proofPrivate}</Txt> : null}
      <Btn label={proofs.length > 0 || !firstTime ? t.done : t.skipForNow} kind={proofs.length > 0 ? 'primary' : 'plain'} onPress={onClose} />
    </Sheet>
  );
}
