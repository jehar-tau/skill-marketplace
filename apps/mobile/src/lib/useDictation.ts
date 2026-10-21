import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { Locale } from './i18n';

// Speech is turned into text by the phone or browser itself where it can be: free, nothing for the
// server to run, and the person sees the words before sending.
const SPEECH_LANG: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };

export function deviceSpeech(): boolean {
  // Browsers only allow the microphone on https pages (and localhost).
  if (Platform.OS === 'web' && (globalThis as { isSecureContext?: boolean }).isSecureContext === false) return false;
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

// Keeps listening until the person taps stop, so they can talk for as long as they need
// (capped at three minutes). Several boxes can be on screen; only the one that started
// listening takes the words. Spoken words are added after whatever was already typed.
const MAX_MS = 180_000;

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ');
// Some recognisers repeat everything heard so far in each result, others send only the new part.
const extend = (sofar: string, heard: string) => (sofar && heard.startsWith(sofar) ? heard : join(sofar, heard));

export function useDictation({ text, setText, locale, onError }: {
  text: string; setText: (v: string) => void; locale: Locale; onError: () => void;
}) {
  const available = useState(deviceSpeech)[0];
  const [listening, setListening] = useState(false);
  const mine = useRef(false);
  const before = useRef('');
  const committed = useRef('');
  const shown = useRef('');
  const startedAt = useRef(0);
  // After stop is tapped the recogniser still sends the last words, then ends.
  const stopping = useRef(false);

  const begin = () =>
    ExpoSpeechRecognitionModule.start({ lang: SPEECH_LANG[locale], interimResults: true, continuous: true });

  const finish = () => {
    mine.current = false;
    stopping.current = false;
    setListening(false);
  };

  useSpeechRecognitionEvent('result', (e) => {
    if (!mine.current) return;
    const heard = e.results[0]?.transcript?.trim() ?? '';
    if (!heard) return;
    const spoken = extend(committed.current, heard);
    if (e.isFinal) committed.current = spoken;
    shown.current = join(before.current, spoken);
    setText(shown.current);
  });
  // The recogniser stops by itself after a pause on some phones and browsers; carry on until the person taps stop.
  useSpeechRecognitionEvent('end', () => {
    if (!mine.current) return;
    if (stopping.current || Date.now() - startedAt.current > MAX_MS) return finish();
    before.current = shown.current;
    committed.current = '';
    try {
      begin();
    } catch {
      finish();
    }
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (!mine.current) return;
    // Silence is not a failure while the person is still thinking; 'end' follows and listening resumes.
    if (e.error === 'no-speech' || e.error === 'speech-timeout') return;
    finish();
    if (e.error !== 'aborted') onError();
  });

  async function toggle() {
    try {
      if (listening) {
        stopping.current = true;
        setListening(false);
        ExpoSpeechRecognitionModule.stop();
        // If the recogniser never reports that it ended, let go anyway.
        setTimeout(() => { if (stopping.current) finish(); }, 3000);
        return;
      }
      if (stopping.current) return;
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) return onError();
      stopping.current = false;
      before.current = text.trim();
      shown.current = before.current;
      committed.current = '';
      startedAt.current = Date.now();
      mine.current = true;
      setListening(true);
      begin();
    } catch {
      finish();
      onError();
    }
  }

  return { available, listening, toggle };
}
