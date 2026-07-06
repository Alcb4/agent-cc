/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@agent-cc/shared"],
  reactStrictMode: true,
  // The shared package uses ESM ".js" specifiers in TS source; value imports
  // (not just `import type`) need webpack to try the .ts file behind them.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
