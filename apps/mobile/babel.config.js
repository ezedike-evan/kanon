module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    // Reanimated's plugin must stay last; it rewrites worklets after everything else.
    plugins: ['react-native-worklets/plugin'],
  };
};
