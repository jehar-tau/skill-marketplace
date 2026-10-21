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

// Fills a text box from speech. Several boxes can be on screen; only the one that started
// listening takes the words. Spoken words are added after whatever was already typed.
export function useDictation({ text, setText, locale, onError }: {
  text: string; setText: (v: string) => void; locale: Locale; onError: () => void;
}) {
  const available = useState(deviceSpeech)[0];
  const [listening, setListening] = useState(false);
  const mine = useRef(false);
  const before = useRef('');

  useSpeechRecognitionEvent('result', (e) => {
    if (!mine.current) return;
    const heard = e.results[0]?.transcript?.trim();
    if (heard) setText(before.current ? `${before.current} ${heard}` : heard);
  });
  useSpeechRecognitionEvent('end', () => {
    if (!mine.current) return;
    mine.current = false;
    setListening(false);
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (!mine.current) return;
    mine.current = false;
    setListening(false);
    if (e.error !== 'aborted' && e.error !== 'no-speech') onError();
  });

  async function toggle() {
    try {
      if (listening) return ExpoSpeechRecognitionModule.stop();
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) return onError();
      before.current = text.trim();
      mine.current = true;
      setListening(true);
      ExpoSpeechRecognitionModule.start({ lang: SPEECH_LANG[locale], interimResults: true, continuous: false });
    } catch {
      mine.current = false;
      setListening(false);
      onError();
    }
  }

  return { available, listening, toggle };
}
