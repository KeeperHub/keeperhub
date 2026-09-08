import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import type { ReactNode } from "react";
import { Anek_Latin } from "next/font/google";
import "nextra-theme-docs/style.css";
import "./globals.css";

import themeConfig from "../theme.config";

const anekLatin = Anek_Latin({
  subsets: ["latin"],
  variable: "--font-anek-latin",
});

export const metadata = {
  title: {
    default: "KeeperHub Docs",
    template: "%s - KeeperHub Docs",
  },
  description: "KeeperHub Documentation - Automate anything onchain",
  icons: {
    icon: "/favicon.ico",
  },
};

// Hidden sections that should not appear in sidebar
const HIDDEN_SECTIONS = ["plans-features", "keeperhub"];

// Filter and reorder page map items
function filterPageMap(
  items: Awaited<ReturnType<typeof getPageMap>>
): typeof items {
  // Filter out hidden sections
  const filtered = items.filter((item) => {
    if ("name" in item && HIDDEN_SECTIONS.includes(item.name)) {
      return false;
    }
    return true;
  });

  // Move FAQ to the end
  const faqIndex = filtered.findIndex(
    (item) => "name" in item && item.name === "FAQ"
  );
  if (faqIndex > -1) {
    const [faq] = filtered.splice(faqIndex, 1);
    filtered.push(faq);
  }

  return filtered;
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const rawPageMap = await getPageMap("/");
  const pageMap = filterPageMap(rawPageMap);

  return (
    <html dir="ltr" lang="en" className={`dark ${anekLatin.variable}`} suppressHydrationWarning>
      <Head>
        <meta content="width=device-width, initial-scale=1.0" name="viewport" />
      </Head>
      <body>
        <Layout
          darkMode={false}
          docsRepositoryBase={themeConfig.docsRepositoryBase}
          editLink={themeConfig.editLink?.content}
          footer={<Footer>{themeConfig.footer?.content}</Footer>}
          navbar={
            <Navbar
              logo={themeConfig.logo}
              projectLink={themeConfig.project?.link}
            />
          }
          pageMap={pageMap}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
