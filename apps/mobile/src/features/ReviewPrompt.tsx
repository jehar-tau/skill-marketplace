import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useApp, useLive } from '../state';
import { Btn, errorText, Field, Sheet, toast, Txt } from '../ui';

interface Pending { agreementId: string; what: string; otherName: string | null; need: 'answer' | 'rate' }

// Pops up when there is a job to confirm or a person to review, so a review is
// asked for at the right moment and not left for the user to go looking.
export function ReviewPrompt() {
  const th = useTheme();
  const { t } = useApp();
  const pending = useLive<Pending[]>(() => api('/v1/reviews/pending'), ['agreement'], []);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const item = (pending.data ?? []).find((p) => !dismissed.has(p.agreementId + p.need));
  const close = () => {
    if (item) setDismissed((d) => new Set(d).add(item.agreementId + item.need));
    setStars(0);
    setComment('');
  };

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setStars(0);
      setComment('');
      await pending.refresh();
    } catch (e) {
      toast(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={!!item} onClose={close} title={item?.need === 'rate' ? t.reviewRate(item.otherName ?? '—') : t.didItHappen}>
      {item ? (
        <>
          <Txt size={16} mute>{item.what}{item.need === 'answer' && item.otherName ? ` · ${item.otherName}` : ''}</Txt>
          {item.need === 'answer' ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn label={t.yes} busy={busy} style={{ flex: 1 }} onPress={() => run(() => api(`/v1/agreements/${item.agreementId}/answer`, { body: { answer: 'yes' } }))} />
              <Btn kind="plain" label={t.no} style={{ flex: 1 }} onPress={() => run(() => api(`/v1/agreements/${item.agreementId}/answer`, { body: { answer: 'no' } }))} />
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 4 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n} / 5`} onPress={() => setStars(n)} style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}>
                    <Txt size={38} color={n <= stars ? th.star : th.line}>★</Txt>
                  </Pressable>
                ))}
              </View>
              {stars > 0 ? <Field value={comment} onChangeText={setComment} placeholder={t.comment} maxLength={500} /> : null}
              <Btn label={t.rateSubmit} busy={busy} disabled={stars === 0}
                onPress={() => run(() => api(`/v1/agreements/${item.agreementId}/rate`, { body: { stars, ...(comment.trim() ? { comment: comment.trim() } : {}) } }))} />
            </>
          )}
          <Btn kind="plain" label={t.later} onPress={close} />
        </>
      ) : null}
    </Sheet>
  );
}
