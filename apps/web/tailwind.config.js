const kanonPreset = require('@kanon/tokens/preset');
const { content } = require('@kanon/ui/tailwind');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  // packages/ui is where the screens are; scanning only ./app would leave every
  // one of them unstyled, silently.
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', ...content],
  presets: [require('nativewind/preset'), kanonPreset()],
};
