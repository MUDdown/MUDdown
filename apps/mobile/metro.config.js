const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages the mobile app depends on
config.watchFolders = [
  path.resolve(monorepoRoot, "packages/shared"),
  path.resolve(monorepoRoot, "packages/client"),
  path.resolve(monorepoRoot, "packages/parser"),
];

// Resolve node_modules from both project and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Workspace packages use `.js` import specifiers in TypeScript source
// (e.g. `import { foo } from "./renderer.js"`). Metro needs a custom resolver
// to map these to the actual `.ts`/`.tsx` source files.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve =
    defaultResolveRequest ??
    ((ctx, name, targetPlatform) => ctx.resolveRequest(ctx, name, targetPlatform));

  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    const isJsSpecifier = moduleName.endsWith(".js");
    const isRelativeOrAbsolute =
      moduleName.startsWith("./") ||
      moduleName.startsWith("../") ||
      moduleName.startsWith("/");

    if (!isJsSpecifier || !isRelativeOrAbsolute) {
      throw error;
    }

    for (const extension of [".ts", ".tsx"]) {
      try {
        return resolve(
          context,
          `${moduleName.slice(0, -3)}${extension}`,
          platform,
        );
      } catch {
        // Try the next TypeScript extension.
      }
    }

    throw error;
  }
};

module.exports = config;
