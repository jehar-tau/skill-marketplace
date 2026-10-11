import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { linkWebManifest, listenForPushes } from '../lib/device';
import { useTheme } from '../lib/theme';
import { AppProvider } from '../state';

function PushRouter() {
  const router = useRouter();
  useEffect(
    () =>
      listenForPushes((data) => {
        if (data?.conversationId) router.push(`/chat/${data.conversationId}`);
        else router.replace('/');
      }),
    [router],
  );
  return null;
}

export default function Layout() {
  const th = useTheme();
  useEffect(linkWebManifest, []);
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="auto" />
        <PushRouter />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: th.bg } }} />
      </AppProvider>
    </SafeAreaProvider>
  );
}
