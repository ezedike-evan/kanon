import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--kanon-font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Kanon',
  description:
    'Your trading strategy, compiled into a contract that refuses trades breaking your own rules.',
};

export const viewport: Viewport = {
  themeColor: '#0B0D10',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body>{children}</body>
    </html>
  );
}
