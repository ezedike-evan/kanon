const kanonPreset = require('@kanon/tokens/preset');
const { content } = require('@kanon/ui/tailwind');
// The native family names come from the same generated file as the colours.

/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scanning packages/ui is not optional: a class NativeWind never sees is
  // dropped without an error, and the screen just renders unstyled.
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', ...content],
  presets: [require('nativewind/preset'), kanonPreset({ mono: kanonPreset.nativeMono })],
};
