import nextra from "nextra";

const withNextra = nextra({
  defaultShowCopyCode: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  async redirects() {
    return [
      // Getting-started consolidation: one section, four paths by interface.
      {
        source: "/getting-started/quickstart",
        destination: "/getting-started/browser",
        permanent: true,
      },
      {
        source: "/getting-started/agent-quickstart",
        destination: "/getting-started/api",
        permanent: true,
      },
      { source: "/cli/quickstart", destination: "/getting-started/cli", permanent: true },
      { source: "/quickstart", destination: "/platform-reference", permanent: true },

      // intro/ folded into the overview and Core Concepts.
      { source: "/intro", destination: "/", permanent: true },
      { source: "/intro/overview", destination: "/", permanent: true },
      { source: "/intro/benefits", destination: "/", permanent: true },
      { source: "/intro/concepts", destination: "/concepts", permanent: true },

      // ai-tools/ renamed to agent/.
      { source: "/ai-tools", destination: "/agent", permanent: true },
      { source: "/ai-tools/overview", destination: "/agent", permanent: true },
      { source: "/ai-tools/:slug", destination: "/agent/:slug", permanent: true },
    ];
  },
};

export default withNextra(nextConfig);
