import type { MetadataRoute } from 'next';

import { colors } from '@kanon/tokens';

/**
 * Installed, Kanon is one dark surface. Both `background_color` and
 * `theme_color` are `void` so there is no light flash between the launch
 * screen and the first frame, which on a mid-range Android is long enough to
 * see.
 *
 * Colours come from the token package for the same reason component styles do:
 * `docs/DESIGN.md` names them once, and the install surface is not an
 * exception to that.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Kanon',
    short_name: 'Kanon',
    description:
      'Your trading strategy, compiled into a contract that refuses trades breaking your own rules.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: colors.void,
    theme_color: colors.void,
    categories: ['finance'],
    lang: 'en',
    dir: 'ltr',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      {
        name: 'Blocked trades',
        short_name: 'Blocked',
        description: 'Every refusal, and how many would have lost.',
        url: '/blocked',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
  };
}
