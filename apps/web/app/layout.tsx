import type { Metadata, Viewport } from 'next';
import { colors } from '@kanon/tokens';
import { Providers } from '@/src/providers';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://kanon.app'),
  title: 'Kanon',
  applicationName: 'Kanon',
  description:
    'Your trading strategy, compiled into a contract that refuses trades breaking your own rules.',
  // `app/manifest.ts` is picked up automatically. These are what Safari reads,
  // since it installs from the tags rather than from the manifest.
  appleWebApp: {
    capable: true,
    title: 'Kanon',
    // The app owns the status bar and is dark everywhere, so it must not get a
    // light bar drawn over `void`.
    statusBarStyle: 'black-translucent',
  },
  // `favicon.ico` first: it is the only one older Android browsers look for.
  // The SVG is the bolder small cut of the rod, with three graduations rather
  // than five, because at 16 px the full mark closes up.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/icons/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // Next emits the standardised `mobile-web-app-capable`; iOS before 17.4 only
  // reads the prefixed one, and the test device is a mid-range phone.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  themeColor: colors.void,
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
