const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The screens live in packages/ui and are compiled from source, so metro has to
// watch the whole workspace rather than just this app.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// jose's package.json "exports" map has a "browser" condition pointing at a
// build that never touches Node's zlib, but Metro doesn't request that
// condition by default, so it falls through to the Node build instead.
// extraNodeModules only acts as a fallback for modules Metro can't otherwise
// find, so it never applies here (jose resolves fine, just to the wrong
// build) — force it via resolveRequest instead.
const josePath = require.resolve('jose/package.json').replace('package.json', 'dist/browser/index.js');

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  crypto: require.resolve('expo-crypto'),
};

const { resolveRequest: originalResolveRequest } = config.resolver;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'jose') {
    return { type: 'sourceFile', filePath: josePath };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
