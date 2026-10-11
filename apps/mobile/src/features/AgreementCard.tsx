import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { formatWhen } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useApp } from '../state';
import { Btn, Card, Chip, errorText, Field, Sheet, toast, Txt } from '../ui';

export interface Agreement {
  id: string; what: string; scheduledFor: string; priceMinor: number | null; state: string; proposedByMe: boolean;
  canConfirm: boolean; canAnswer: boolean; myAnswer: string | null; canRate: boolean; myRating: number | null;
  theirRating: { stars: number; comment: string | null } | null;
}

const HOURS = [8, 10, 12, 14, 16, 18, 20];

// Agreement, "did it happen?" and rating in one card pinned above the chat (spec §8.1–8.3).
export function AgreementCard({ conversationId, agreement, canPropose, onChange }: {
  conversationId: string; agreement: Agreement | null; canPropose: boolean; onChange: () => void;
}) {
  const th = useTheme();
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [day, setDay] = useState(0);
  const [hour, setHour] = useState(18);
  const [price, setPrice] = useState('');
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      toast(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function propose() {
    const when = new Date();
    when.setDate(when.getDate() + day);
    when.setHours(hour, 0, 0, 0);
    const rupees = Number(price.replace(/\D/g, ''));
    return run(async () => {
      await api(`/v1/conversations/${conversationId}/agreement`, {
        body: { what: what.trim(), scheduledFor: when.toISOString(), ...(rupees > 0 ? { priceMinor: rupees * 100 } : {}) },
      });
      setOpen(false);
    });
  }

  const a = agreement;
  const summary = a ? (
    <View style={{ gap: 2 }}>
      <Txt size={16} weight="600">{a.what}</Txt>
      <Txt size={14} mute>{formatWhen(a.scheduledFor, t)}{a.priceMinor ? ` · ₹${a.priceMinor / 100}` : ''}</Txt>
    </View>
  ) : null;

  let body = null;
  if (!a) {
    if (!canPropose) return null;
    body = <Btn small kind="soft" label={t.weAgreed} onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />;
  } else if (a.state === 'proposed') {
    body = (
      <>
        {summary}
        <Txt size={14} color={th.accent}>{a.proposedByMe ? t.agreementProposedMine : t.agreementProposedTheirs}</Txt>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {a.canConfirm ? <Btn small label={t.confirmAgreement} busy={busy} onPress={() => run(() => api(`/v1/agreements/${a.id}/confirm`, { method: 'POST' }))} /> : null}
          {a.proposedByMe ? <Btn small kind="plain" label={t.withdraw} onPress={() => run(() => api(`/v1/agreements/${a.id}/withdraw`, { method: 'POST' }))} /> : null}
        </View>
      </>
    );
  } else if (a.state === 'confirmed') {
    body = (
      <>
        <Txt size={13} weight="600" color={th.accent}>{t.agreementConfirmed}</Txt>
        {summary}
        {a.canAnswer ? (
          <>
            <Txt size={15} weight="600">{t.didItHappen}</Txt>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn small label={t.yes} busy={busy} onPress={() => run(() => api(`/v1/agreements/${a.id}/answer`, { body: { answer: 'yes' } }))} />
              <Btn small kind="plain" label={t.no} onPress={() => run(() => api(`/v1/agreements/${a.id}/answer`, { body: { answer: 'no' } }))} />
            </View>
          </>
        ) : a.myAnswer ? <Txt size={14} mute>{t.waitingOther}</Txt> : null}
      </>
    );
  } else if (a.state === 'completed') {
    body = (
      <>
        <Txt size={13} weight="600" color={th.accent}>{t.jobCompleted}</Txt>
        {summary}
        {a.canRate ? (
          <>
            <Txt size={15} weight="600">{t.rateTitle}</Txt>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n} / 5`} onPress={() => setStars(n)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                  <Txt size={30} color={n <= stars ? th.star : th.line}>★</Txt>
                </Pressable>
              ))}
            </View>
            {stars > 0 ? (
              <>
                <Field value={comment} onChangeText={setComment} placeholder={t.comment} maxLength={500} />
                <Btn small label={t.rateSubmit} busy={busy} onPress={() => run(() => api(`/v1/agreements/${a.id}/rate`, { body: { stars, ...(comment.trim() ? { comment: comment.trim() } : {}) } }))} />
              </>
            ) : null}
          </>
        ) : a.theirRating ? (
          <Txt size={14}>{t.theyRated}: <Txt size={14} color={th.star} weight="700">{'★'.repeat(a.theirRating.stars)}</Txt>{a.theirRating.comment ? ` — ${a.theirRating.comment}` : ''}</Txt>
        ) : <Txt size={14} mute>{t.rated}</Txt>}
      </>
    );
  } else {
    body = (
      <>
        {summary}
        <Txt size={14} mute>{a.state === 'disputed' ? t.jobDisputed : a.state === 'not_done' ? t.jobNotDone : t.jobCompleted}</Txt>
      </>
    );
  }

  return (
    <>
      <Card style={{ marginHorizontal: 12, marginTop: 8 }}>{body}</Card>
      <Sheet visible={open} onClose={() => setOpen(false)} title={t.agreeTitle}>
        <Field label={t.agreeWhat} value={what} onChangeText={setWhat} maxLength={300} autoFocus />
        <Txt size={14} mute>{t.agreeWhen}</Txt>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[t.today, t.tomorrow, t.dayAfter].map((label, i) => <Chip key={label} label={label} on={day === i} onPress={() => setDay(i)} />)}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {HOURS.map((h) => <Chip key={h} label={`${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`} on={hour === h} onPress={() => setHour(h)} />)}
        </View>
        <Field label={t.agreePrice} value={price} onChangeText={setPrice} keyboardType="number-pad" maxLength={7} />
        <Btn label={t.propose} busy={busy} disabled={what.trim().length < 2} onPress={propose} />
      </Sheet>
    </>
  );
}
