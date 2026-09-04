import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@/protocols";
import { ProtocolDetailPage } from "@/components/hub/protocol-detail-page";
import { getProtocol } from "@/lib/protocol-registry";

type Props = { params: Promise<{ slug: string }> };

const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const protocol = getProtocol(slug);
  if (!protocol) {
    return {};
  }

  const title = `${protocol.name} Protocol | KeeperHub`;
  const description = protocol.description.replace(/ -- /g, ". ");

  return {
    title,
    description,
    // See the note in app/hub/page.tsx: without an explicit canonical this
    // inherits `/` from the root layout and every protocol page reports itself
    // a duplicate of the homepage.
    alternates: { canonical: `/hub/protocol/${slug}` },
    openGraph: {
      title,
      description,
      type: "website",
      url: `${baseUrl}/hub/protocol/${slug}`,
      siteName: "KeeperHub",
      images: [
        {
          url: `${baseUrl}/api/og/protocol/${slug}`,
          width: 1200,
          height: 630,
          alt: `${protocol.name} on KeeperHub`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${baseUrl}/api/og/protocol/${slug}`],
    },
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const protocol = getProtocol(slug);
  if (!protocol) {
    notFound();
  }
  return <ProtocolDetailPage protocol={protocol} />;
}
