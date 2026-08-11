import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

type WorkflowLayoutProps = {
  children: ReactNode;
  params: Promise<{ workflowId: string }>;
};

export async function generateMetadata({
  params,
}: WorkflowLayoutProps): Promise<Metadata> {
  const { workflowId } = await params;

  // Try to fetch the workflow to get its name
  let title = "Workflow";
  // isShareable = anyone with the link may view (public OR unlisted). Drives
  // both name/OG-image exposure in metadata and rich link previews; private
  // workflows stay fully redacted to prevent name enumeration.
  let isShareable = false;

  try {
    const workflow = await db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), workflowNotDeleted()),
      columns: {
        name: true,
        visibility: true,
      },
    });

    if (workflow) {
      isShareable = workflow.visibility !== "private";
      if (isShareable) {
        title = workflow.name;
      }
    }
  } catch {
    // Ignore errors, use defaults
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL || "https://app.keeperhub.com";
  const workflowUrl = `${baseUrl}/workflows/${workflowId}`;
  const ogImageUrl = isShareable
    ? `${baseUrl}/api/og/workflow/${workflowId}`
    : `${baseUrl}/api/og/default`;

  return {
    title: `${title} | KeeperHub`,
    description: `View and explore the "${title}" workflow built with KeeperHub.`,
    openGraph: {
      title: `${title} | KeeperHub`,
      description: `View and explore the "${title}" workflow built with KeeperHub.`,
      type: "website",
      url: workflowUrl,
      siteName: "KeeperHub",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${title} workflow visualization`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | KeeperHub`,
      description: `View and explore the "${title}" workflow built with KeeperHub.`,
      images: [ogImageUrl],
    },
  };
}

export default function WorkflowLayout({ children }: WorkflowLayoutProps) {
  // Opt out of in-browser auto-translation (Google Translate, Edge, etc.) on
  // the editor. Translators replace text nodes with <font> wrappers, which
  // breaks React's reconciler and throws NotFoundError on insertBefore /
  // removeChild. Marketing / hub pages remain translatable.
  return (
    <div className="contents" translate="no">
      {children}
    </div>
  );
}
