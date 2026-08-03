import nextra from "nextra";

const withNextra = nextra({
  defaultShowCopyCode: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    instrumentationHook: false,
  },
};

export default withNextra(nextConfig);
