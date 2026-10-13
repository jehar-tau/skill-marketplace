import { useColorScheme } from 'react-native';

const light = {
  bg: '#F6F5F2', card: '#FFFFFF', ink: '#1C1B19', mute: '#6B6862', line: '#E4E1DA', accent: '#0F6B57', accentInk: '#FFFFFF',
  accentSoft: '#E1F1EC', warn: '#B3261E', warnSoft: '#FCE8E6', bubbleMine: '#0F6B57', bubbleMineInk: '#FFFFFF', bubbleTheirs: '#FFFFFF',
  star: '#B7791F',
  // Two roles, two colours: green when you are the one helping, indigo when someone is helping you.
  asCustomer: '#3949AB', asCustomerSoft: '#E8EAF6',
};
const dark: typeof light = {
  bg: '#141412', card: '#1F1E1B', ink: '#EEECE7', mute: '#A09C94', line: '#34322D', accent: '#5CC4A8', accentInk: '#0B2A22',
  accentSoft: '#1D332D', warn: '#FF8A80', warnSoft: '#3A1F1D', bubbleMine: '#2B7F6B', bubbleMineInk: '#FFFFFF', bubbleTheirs: '#26251F',
  star: '#E0B252',
  asCustomer: '#A5B0F0', asCustomerSoft: '#23274A',
};
export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
