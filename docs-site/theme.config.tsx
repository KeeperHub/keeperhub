import { KeeperHubLogo } from "./components/keeperhub-logo";

const config = {
  logo: (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}
    >
      <KeeperHubLogo />
      <span
        style={{
          color: "#7a9ca8",
          fontWeight: 400,
          fontSize: "13px",
        }}
      >
        Docs
      </span>
    </span>
  ),
  project: {
    link: "https://github.com/KeeperHub/keeperhub",
  },
  docsRepositoryBase:
    "https://github.com/KeeperHub/keeperhub/edit/staging/docs",
  footer: {
    content: (
      <span style={{ color: "#7a9ca8", fontSize: "13px" }}>
        {new Date().getFullYear()} KeeperHub. All rights reserved.
      </span>
    ),
  },
  head: (
    <>
      <meta content="width=device-width, initial-scale=1.0" name="viewport" />
      <meta
        content="KeeperHub Documentation - Automate anything onchain"
        name="description"
      />
      <meta content="KeeperHub Docs" name="og:title" />
      <link href="/favicon.ico" rel="icon" />
    </>
  ),
  useNextSeoProps() {
    return {
      titleTemplate: "%s - KeeperHub Docs",
    };
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  editLink: {
    content: "Edit this page on GitHub",
  },
  feedback: {
    content: "Question? Give us feedback",
    labels: "feedback",
  },
  navigation: {
    prev: true,
    next: true,
  },
  darkMode: false,
  primaryHue: 152,
  primarySaturation: 90,
};

export default config;
