import { Platform, Pressable, TextInput, View } from 'react-native';
import { useTheme } from '../lib/theme';
import { useDictation } from '../lib/useDictation';
import { useApp } from '../state';
import { Txt } from '../ui';

// A large box to answer one question, by typing or by tapping the microphone and speaking.
export function SpeakOrType({ value, onChange, placeholder, onVoiceError, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder: string; onVoiceError: () => void; autoFocus?: boolean;
}) {
  const th = useTheme();
  const { t, locale } = useApp();
  const dictation = useDictation({ text: value, setText: onChange, locale, onError: onVoiceError });
  const on = dictation.listening;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ backgroundColor: th.card, borderRadius: 18, borderWidth: 1, borderColor: on ? th.warn : th.line, padding: 14, minHeight: 140 }}>
        <TextInput
          value={on && !value ? t.listening : value}
          editable={!on}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={th.mute}
          multiline
          autoFocus={autoFocus && !dictation.available}
          accessibilityLabel={placeholder}
          style={{ flex: 1, fontSize: 18, lineHeight: 27, color: on && !value ? th.warn : th.ink, minHeight: 110, textAlignVertical: 'top', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
        />
      </View>
      {dictation.available ? (
        <Pressable accessibilityRole="button" accessibilityLabel={on ? t.stopTalking : t.tapToTalk} onPress={() => void dictation.toggle()}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 52, borderRadius: 26, backgroundColor: on ? th.warn : th.accentSoft }}>
          <Txt size={20} color={on ? '#fff' : th.accent}>{on ? '■' : '🎤'}</Txt>
          <Txt size={16} weight="700" color={on ? '#fff' : th.accent}>{on ? t.stopTalking : t.tapToTalk}</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}
