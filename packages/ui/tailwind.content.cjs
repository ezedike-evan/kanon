/**
 * The glob every app's tailwind config must include, resolved from this
 * package rather than spelled out relative to each app — a NativeWind class
 * that is never scanned is silently dropped, and that failure is invisible
 * until a screen renders unstyled.
 */
const { dirname, join } = require('node:path');

module.exports = { content: [join(dirname(require.resolve('@kanon/ui/package.json')), 'src/**/*.{ts,tsx}')] };
