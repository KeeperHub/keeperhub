import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "@vercel/og";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Font loading (Anek Latin, bundled locally)
// ---------------------------------------------------------------------------

// The host printed as a watermark on every generated card. Derived from the
// deployment's own URL so a deployment KeeperHub does not run does not stamp
// our domain onto its social previews. Server-only module, so this is a runtime
// read; unset reproduces the literal both sites carried.
const OG_WATERMARK_HOST = (() => {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) {
    return "app.keeperhub.com";
  }
  try {
    return new URL(configured).host;
  } catch {
    return "app.keeperhub.com";
  }
})();

const fontsDir = join(process.cwd(), "app/api/og/fonts");

const fontRegularPromise = readFile(
  join(fontsDir, "AnekLatin-Regular.ttf")
).then((buf) => buf.buffer as ArrayBuffer);

const fontSemiBoldPromise = readFile(
  join(fontsDir, "AnekLatin-SemiBold.ttf")
).then((buf) => buf.buffer as ArrayBuffer);

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const DOT_SPACING = 32;

const LOGO_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 318 500' fill='none'%3E%3Cpath d='M317.77 204.279H226.98V295.069H317.77V204.279Z' fill='%2300FF4F'/%3E%3Cpath d='M204.28 90.79V0H113.49V90.79C113.456 120.879 101.488 149.725 80.2115 171.002C58.9355 192.278 30.0889 204.246 0 204.28V295.07C30.0889 295.104 58.9355 307.072 80.2115 328.348C101.488 349.625 113.456 378.471 113.49 408.56V499.35H204.28V408.56C204.28 378.075 197.445 347.977 184.279 320.482C171.113 292.987 151.95 268.793 128.2 249.68C151.948 230.563 171.109 206.367 184.275 178.871C197.441 151.374 204.277 121.276 204.28 90.79Z' fill='%2300FF4F'/%3E%3C/svg%3E";

const NODE_BORDER_GREEN = "rgba(0,255,79,0.45)";
const NODE_BORDER_GREEN_BRIGHT = "rgba(0,255,79,0.65)";
const EDGE_COLOR = "rgba(0,255,79,0.15)";

const BG_COLOR = "#111827";
const CARD_COLOR = "#1e293b";
const DOT_COLOR = "rgba(255,255,255,0.35)";
const VIGNETTE =
  "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.4) 100%)";
const GRADIENT =
  "linear-gradient(180deg, rgba(17,24,39,0.95) 0%, rgba(17,24,39,0.85) 15%, rgba(17,24,39,0.4) 35%, rgba(17,24,39,0.3) 50%, rgba(17,24,39,0.4) 65%, rgba(17,24,39,0.6) 80%, rgba(17,24,39,0.95) 100%)";

// ---------------------------------------------------------------------------
// Shared icon SVG data URIs (matching lucide-react icons used in workflow UI)
// ---------------------------------------------------------------------------

const LUCIDE = (inner: string): string =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23aaaaaa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E${inner}%3C/svg%3E`;

// Trigger icons (from components/workflow/nodes/trigger-node.tsx)
const ICON_PLAY = LUCIDE(
  "%3Cpath d='M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'/%3E"
);
const ICON_CLOCK = LUCIDE(
  "%3Cpath d='M12 6v6l4 2'/%3E%3Ccircle cx='12' cy='12' r='10'/%3E"
);
const ICON_WEBHOOK = LUCIDE(
  "%3Cpath d='M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2'/%3E%3Cpath d='m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06'/%3E%3Cpath d='m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8'/%3E"
);
const ICON_BOXES = LUCIDE(
  "%3Cpath d='M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z'/%3E%3Cpath d='m7 16.5-4.74-2.85'/%3E%3Cpath d='m7 16.5 5-3'/%3E%3Cpath d='M7 16.5v5.17'/%3E%3Cpath d='M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z'/%3E%3Cpath d='m17 16.5-5-3'/%3E%3Cpath d='m17 16.5 4.74-2.85'/%3E%3Cpath d='M17 16.5v5.17'/%3E%3Cpath d='M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z'/%3E%3Cpath d='M12 8 7.26 5.15'/%3E%3Cpath d='m12 8 4.74-2.85'/%3E%3Cpath d='M12 13.5V8'/%3E"
);

// System action icons (from components/workflow/nodes/action-node.tsx)
const ICON_ZAP = LUCIDE(
  "%3Cpath d='M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'/%3E"
);
const ICON_DATABASE = LUCIDE(
  "%3Cellipse cx='12' cy='5' rx='9' ry='3'/%3E%3Cpath d='M3 5V19A9 3 0 0 0 21 19V5'/%3E%3Cpath d='M3 12A9 3 0 0 0 21 12'/%3E"
);
const ICON_CODE = LUCIDE(
  "%3Cpath d='m16 18 6-6-6-6'/%3E%3Cpath d='m8 6-6 6 6 6'/%3E"
);
const ICON_GIT_BRANCH = LUCIDE(
  "%3Cline x1='6' x2='6' y1='3' y2='15'/%3E%3Ccircle cx='18' cy='6' r='3'/%3E%3Ccircle cx='6' cy='18' r='3'/%3E%3Cpath d='M18 9a9 9 0 0 1-9 9'/%3E"
);

// Plugin icons (from plugins/*/icon.tsx)
const ICON_GLOBE = LUCIDE(
  "%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'/%3E%3Cpath d='M2 12h20'/%3E"
);
const ICON_MAIL = LUCIDE(
  "%3Cpath d='m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7'/%3E%3Crect x='2' y='4' width='20' height='16' rx='2'/%3E"
);
const ICON_BELL = LUCIDE(
  "%3Cpath d='M10.268 21a2 2 0 0 0 3.464 0'/%3E%3Cpath d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/%3E"
);
const ICON_SEND = LUCIDE(
  "%3Cpath d='M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z'/%3E%3Cpath d='m21.854 2.147-10.94 10.939'/%3E"
);
const ICON_SWAP = LUCIDE(
  "%3Cpath d='m16 3 4 4-4 4'/%3E%3Cpath d='M20 7H4'/%3E%3Cpath d='m8 21-4-4 4-4'/%3E%3Cpath d='M4 17h16'/%3E"
);
const ICON_DOLLAR = LUCIDE(
  "%3Cline x1='12' x2='12' y1='2' y2='22'/%3E%3Cpath d='M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'/%3E"
);

// Brand icons (from plugins/discord/icon.tsx, telegram/icon.tsx)
const ICON_DISCORD =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 586 446' fill='none'%3E%3Cpath d='M495.562 37.06C458.062 19.87 418.218 7.37 376.343 0.03c-.78 0-1.56 0-1.87.94-5.16 9.22-10.94 21.09-14.85 30.47-45.31-6.72-89.84-6.72-133.9 0-4.07-9.69-9.85-21.4-15.63-31.34-.47-.63-1.09-1.1-1.87-.94C172.28 7.22 126.34 20.34 89.47 37.06c-.31 0-.63.31-.78.63C12.12 151.75-8.19 261.12 2.75 370.5c0 .47.31 1.09.78 1.56 50 36.88 98.44 59.38 146.25 73.91.78 0 1.56 0 2.03-.63 11.25-15.31 21.25-31.56 30-48.75.47-.94 0-2.19-1.09-2.5-15.63-6.25-31.25-13.44-45.78-21.88-1.1-.62-1.25-2.34 0-3.12 3.12-2.34 6.25-4.69 9.06-7.03.47-.47 1.25-.47 1.88-.31 95.94 43.75 200 43.75 293.75 0 .63-.31 1.41-.16 1.88.31 2.97 2.5 5.94 4.69 9.06 7.03 1.1.78.94 2.5 0 3.12-14.53 8.6-29.69 15.63-45.78 21.88-1.1.47-1.56 1.56-.94 2.66 8.75 17.19 18.91 33.28 29.69 48.44.47.63 1.25.94 2.03.63 47.82-14.84 96.41-37.19 146.56-73.91.47-.31.78-.78.78-1.56 12.19-126.41-20.47-237-68.56-333.01-.16-.31-.47-.63-.78-.63zM195.56 304.25c-29.69 0-53.12-26.56-53.12-59.38 0-32.81 23.44-59.38 53.12-59.38s53.69 26.56 53.12 59.38c0 32.81-23.44 59.38-53.12 59.38zm195.31 0c-29.69 0-53.12-26.56-53.12-59.38 0-32.81 23.44-59.38 53.12-59.38s53.69 26.56 53.12 59.38c0 32.81-23.44 59.38-53.12 59.38z' fill='%235865F2'/%3E%3C/svg%3E";

const ICON_TELEGRAM =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23229ED9'/%3E%3Cpath d='M22.987 10.209a.5.5 0 0 0-.644-.627l-14.265 6.263a.5.5 0 0 0 .057 .936l2.942.937a1.5 1.5 0 0 0 1.16-.252l6.632-4.582c.2-.138.418.146.247.322l-4.774 4.922a1 1 0 0 0 .186 1.636l5.345 3.352a1 1 0 0 0 1.483-.726l1.845-11.913z' fill='white'/%3E%3C/svg%3E";

// ---------------------------------------------------------------------------
// Icon mapping rules (matching workflow UI node icon assignment)
// ---------------------------------------------------------------------------

const ICON_RULES: Array<{ keywords: string[]; icon: string }> = [
  { keywords: ["schedule", "cron", "timer", "interval"], icon: ICON_CLOCK },
  { keywords: ["webhook", "http request"], icon: ICON_WEBHOOK },
  { keywords: ["on-chain", "event", "monitor", "watch"], icon: ICON_BOXES },
  { keywords: ["condition", "filter", "branch", "if"], icon: ICON_GIT_BRANCH },
  { keywords: ["discord"], icon: ICON_DISCORD },
  { keywords: ["telegram"], icon: ICON_TELEGRAM },
  { keywords: ["slack", "notify", "alert", "notification"], icon: ICON_BELL },
  { keywords: ["swap", "exchange", "trade"], icon: ICON_SWAP },
  { keywords: ["transfer", "send"], icon: ICON_SEND },
  { keywords: ["email", "sendgrid", "mail"], icon: ICON_MAIL },
  { keywords: ["execute", "code", "script"], icon: ICON_CODE },
  { keywords: ["database", "query", "sql"], icon: ICON_DATABASE },
  {
    keywords: ["price", "balance", "fee", "spread", "cost"],
    icon: ICON_DOLLAR,
  },
  {
    keywords: ["check", "fetch", "read", "position", "liquidity", "web3"],
    icon: ICON_GLOBE,
  },
  { keywords: ["api", "request", "http"], icon: ICON_ZAP },
  { keywords: ["manual", "trigger"], icon: ICON_PLAY },
];

const HUB_ICONS: Record<string, string> = {
  Schedule: ICON_CLOCK,
  Swap: ICON_SWAP,
  Transfer: ICON_SEND,
  Monitor: ICON_BOXES,
  Notify: ICON_BELL,
  Condition: ICON_GIT_BRANCH,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type DotPosition = { x: number; y: number };

function generateDots(
  width: number,
  height: number,
  spacing: number
): DotPosition[] {
  const dots: DotPosition[] = [];
  for (let x = spacing; x < width; x += spacing) {
    for (let y = spacing; y < height; y += spacing) {
      dots.push({ x, y });
    }
  }
  return dots;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function getNodeIcon(label: string): string {
  const lower = label.toLowerCase();
  const match = ICON_RULES.find((rule) =>
    rule.keywords.some((kw) => lower.includes(kw))
  );
  return match?.icon ?? ICON_PLAY;
}

function getNodeLabel(node: WorkflowNode): string {
  if (node.data.label) {
    return node.data.label;
  }
  if (node.data.type === "trigger") {
    return node.data.config?.triggerType ?? "Manual";
  }
  return node.data.config?.actionType ?? "Action";
}

const DOTS = generateDots(OG_WIDTH, OG_HEIGHT, DOT_SPACING);

// ---------------------------------------------------------------------------
// Shared base layout - background, dots, vignette, gradient
// ---------------------------------------------------------------------------

function OGBase({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: BG_COLOR,
        fontFamily: "'Anek Latin', sans-serif",
      }}
    >
      {DOTS.map((dot) => (
        <div
          key={`dot-${dot.x}-${dot.y}`}
          style={{
            position: "absolute",
            left: dot.x - 1,
            top: dot.y - 1,
            width: 2,
            height: 2,
            borderRadius: 1,
            backgroundColor: DOT_COLOR,
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: VIGNETTE,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: GRADIENT,
        }}
      />
      {children}
    </div>
  );
}

async function renderOGImage(
  content: React.JSX.Element,
  cacheSeconds: number
): Promise<ImageResponse> {
  const [regular, semiBold] = await Promise.all([
    fontRegularPromise,
    fontSemiBoldPromise,
  ]);
  return new ImageResponse(content, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: [
      {
        name: "Anek Latin",
        data: regular,
        weight: 400,
        style: "normal" as const,
      },
      {
        name: "Anek Latin",
        data: semiBold,
        weight: 600,
        style: "normal" as const,
      },
    ],
    headers: {
      "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds * 24}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Default OG
// ---------------------------------------------------------------------------

export function generateDefaultOGImage(): Promise<ImageResponse> {
  return renderOGImage(
    <OGBase>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        {/* biome-ignore lint/a11y/useAltText: OG image render context */}
        {/* biome-ignore lint/performance/noImgElement: Satori requires img */}
        <img
          height={88}
          src={LOGO_SVG}
          style={{ width: 56, height: 88 }}
          width={56}
        />
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 400,
            color: "#ffffff",
            marginTop: 8,
          }}
        >
          KeeperHub
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 28,
            fontWeight: 400,
            color: "rgba(255,255,255,0.45)",
          }}
        >
          Automate anything onchain
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 40,
          right: 56,
          display: "flex",
          fontSize: 24,
          color: "rgba(255,255,255,0.3)",
        }}
      >
        {OG_WATERMARK_HOST}
      </div>
    </OGBase>,
    86_400
  );
}

// ---------------------------------------------------------------------------
// Hub OG
// ---------------------------------------------------------------------------

type HubCard = { label: string; x: number; y: number };

const HUB_CARDS: HubCard[] = [
  { label: "Schedule", x: 100, y: 330 },
  { label: "Swap", x: 290, y: 330 },
  { label: "Transfer", x: 480, y: 330 },
  { label: "Monitor", x: 670, y: 330 },
  { label: "Notify", x: 860, y: 330 },
  { label: "Condition", x: 1050, y: 330 },
];

export function generateHubOGImage(): Promise<ImageResponse> {
  return renderOGImage(
    <OGBase>
      {/* Edge lines connecting cards */}
      {HUB_CARDS.slice(0, -1).map((card, i) => {
        const next = HUB_CARDS[i + 1];
        return (
          <div
            key={`edge-${card.label}`}
            style={{
              position: "absolute",
              left: card.x + 100,
              top: card.y + 50,
              width: next.x - card.x - 100,
              height: 2,
              backgroundColor: EDGE_COLOR,
            }}
          />
        );
      })}

      {/* Preview workflow cards */}
      {HUB_CARDS.map((card) => (
        <div
          key={card.label}
          style={{
            position: "absolute",
            left: card.x,
            top: card.y,
            width: 100,
            height: 100,
            borderRadius: 14,
            backgroundColor: CARD_COLOR,
            border: `1.5px solid ${NODE_BORDER_GREEN}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            gap: 8,
          }}
        >
          {/* biome-ignore lint/a11y/useAltText: OG image render context */}
          {/* biome-ignore lint/performance/noImgElement: Satori requires img */}
          <img
            height={32}
            src={HUB_ICONS[card.label] ?? ICON_ZAP}
            style={{ width: 32, height: 32 }}
            width={32}
          />
          <div
            style={{
              fontSize: 12,
              color: "rgba(255,255,255,0.55)",
              fontWeight: 400,
              textAlign: "center",
            }}
          >
            {card.label}
          </div>
        </div>
      ))}

      {/* Top content */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "60%",
          display: "flex",
          flexDirection: "column",
          padding: "40px 56px 0",
        }}
      >
        <Header />
        <div
          style={{
            display: "flex",
            fontSize: 58,
            fontWeight: 600,
            color: "#ffffff",
            marginTop: 36,
            lineHeight: 1.15,
          }}
        >
          Workflow Hub
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            fontWeight: 400,
            color: "rgba(255,255,255,0.5)",
            marginTop: 14,
            lineHeight: 1.4,
          }}
        >
          Discover and deploy community-built blockchain automations
        </div>
      </div>

      <Footer>
        <div style={{ display: "flex" }}>Featured workflows</div>
        <div style={{ display: "flex" }}>Community templates</div>
        <div style={{ display: "flex" }}>One-click deploy</div>
      </Footer>
    </OGBase>,
    86_400
  );
}

// ---------------------------------------------------------------------------
// Workflow OG
// ---------------------------------------------------------------------------

type WorkflowNode = {
  id: string;
  position: { x: number; y: number };
  data: {
    type: "trigger" | "action" | "add";
    label?: string;
    config?: { triggerType?: string; actionType?: string };
  };
};

type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

type Viewport = { scale: number; offsetX: number; offsetY: number };

type EdgeLine = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  midY: number;
};

function calculateViewport(
  nodes: WorkflowNode[],
  paddingTop: number,
  paddingBottom: number,
  paddingSides: number
): Viewport {
  if (nodes.length === 0) {
    return { scale: 1, offsetX: OG_WIDTH / 2, offsetY: OG_HEIGHT / 2 };
  }

  const nodeSize = 192;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + nodeSize);
    maxY = Math.max(maxY, node.position.y + nodeSize);
  }

  const contentWidth = maxX - minX || 1;
  const contentHeight = maxY - minY || 1;
  const availableWidth = OG_WIDTH - paddingSides * 2;
  const availableHeight = OG_HEIGHT - paddingTop - paddingBottom;

  const scale = Math.min(
    availableWidth / contentWidth,
    availableHeight / contentHeight,
    0.8
  );

  const scaledWidth = contentWidth * scale;
  const scaledHeight = contentHeight * scale;

  return {
    scale,
    offsetX: (OG_WIDTH - scaledWidth) / 2 - minX * scale,
    offsetY: paddingTop + (availableHeight - scaledHeight) / 2 - minY * scale,
  };
}

function transformPosition(
  x: number,
  y: number,
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: x * viewport.scale + viewport.offsetX,
    y: y * viewport.scale + viewport.offsetY,
  };
}

function buildEdgeLines(
  edges: WorkflowEdge[],
  nodeCenters: Map<string, { x: number; y: number }>
): EdgeLine[] {
  const lines: EdgeLine[] = [];
  for (const edge of edges) {
    const src = nodeCenters.get(edge.source);
    const tgt = nodeCenters.get(edge.target);
    if (src && tgt) {
      lines.push({
        id: edge.id,
        x1: src.x,
        y1: src.y,
        x2: tgt.x,
        y2: tgt.y,
        midY: (src.y + tgt.y) / 2,
      });
    }
  }
  return lines;
}

type OGRenderData = {
  nodes: WorkflowNode[];
  edges: EdgeLine[];
  viewport: Viewport;
  ns: number;
  title: string;
  description: string | null;
  triggerLabel: string | undefined;
  actionCount: number;
};

function prepareRenderData(workflowData: {
  name: string;
  description: string | null;
  nodes: unknown[];
  edges: unknown[];
}): OGRenderData {
  const allNodes = (workflowData.nodes ?? []) as WorkflowNode[];
  const nodes = allNodes.filter((n) => n.data?.type !== "add" && n.position);
  const rawEdges = (workflowData.edges ?? []) as WorkflowEdge[];

  const viewport = calculateViewport(nodes, 260, 120, 100);
  const ns = 192 * viewport.scale;

  const nodeCenters = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const pos = transformPosition(node.position.x, node.position.y, viewport);
    nodeCenters.set(node.id, { x: pos.x + ns / 2, y: pos.y + ns / 2 });
  }

  const triggerNode = nodes.find((n) => n.data.type === "trigger");

  return {
    nodes,
    edges: buildEdgeLines(rawEdges, nodeCenters),
    viewport,
    ns,
    title: workflowData.name,
    description: workflowData.description,
    triggerLabel: triggerNode ? getNodeLabel(triggerNode) : undefined,
    actionCount: nodes.filter((n) => n.data.type === "action").length,
  };
}

function renderWorkflowOG(data: OGRenderData): Promise<ImageResponse> {
  const { nodes, edges, viewport, ns } = data;
  return renderOGImage(
    <OGBase>
      {/* Edge lines - vertical from source */}
      {edges.map((line) => (
        <div
          key={`${line.id}-v1`}
          style={{
            position: "absolute",
            left: line.x1 - 1,
            top: Math.min(line.y1, line.midY),
            width: 2,
            height: Math.abs(line.midY - line.y1) || 1,
            backgroundColor: EDGE_COLOR,
          }}
        />
      ))}

      {/* Edge lines - horizontal */}
      {edges
        .filter((line) => Math.abs(line.x2 - line.x1) >= 2)
        .map((line) => (
          <div
            key={`${line.id}-h`}
            style={{
              position: "absolute",
              left: Math.min(line.x1, line.x2),
              top: line.midY - 1,
              width: Math.abs(line.x2 - line.x1),
              height: 2,
              backgroundColor: EDGE_COLOR,
            }}
          />
        ))}

      {/* Edge lines - vertical to target */}
      {edges.map((line) => (
        <div
          key={`${line.id}-v2`}
          style={{
            position: "absolute",
            left: line.x2 - 1,
            top: Math.min(line.y2, line.midY),
            width: 2,
            height: Math.abs(line.y2 - line.midY) || 1,
            backgroundColor: EDGE_COLOR,
          }}
        />
      ))}

      {/* Workflow nodes */}
      {nodes.map((node) => {
        const pos = transformPosition(
          node.position.x,
          node.position.y,
          viewport
        );
        const nodeSquare = Math.max(ns * 0.7, 110);
        const isTrigger = node.data.type === "trigger";
        const label = getNodeLabel(node);
        const iconSize = Math.max(nodeSquare * 0.32, 30);

        return (
          <div
            key={node.id}
            style={{
              position: "absolute",
              left: pos.x + (ns - nodeSquare) / 2,
              top: pos.y + (ns - nodeSquare) / 2,
              width: nodeSquare,
              height: nodeSquare,
              borderRadius: 14,
              backgroundColor: CARD_COLOR,
              border: `2px solid ${isTrigger ? NODE_BORDER_GREEN_BRIGHT : NODE_BORDER_GREEN}`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
              gap: 8,
            }}
          >
            {/* biome-ignore lint/a11y/useAltText: OG image render context */}
            {/* biome-ignore lint/performance/noImgElement: Satori requires img */}
            <img
              height={iconSize}
              src={getNodeIcon(label)}
              style={{ width: iconSize, height: iconSize }}
              width={iconSize}
            />
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.55)",
                fontWeight: 400,
                textAlign: "center",
                padding: "0 6px",
              }}
            >
              {truncate(label, 14)}
            </div>
          </div>
        );
      })}

      {/* Top content */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "55%",
          display: "flex",
          flexDirection: "column",
          padding: "40px 56px 0",
        }}
      >
        <Header />
        <div
          style={{
            display: "flex",
            fontSize: 58,
            fontWeight: 600,
            color: "#ffffff",
            marginTop: 36,
            lineHeight: 1.15,
          }}
        >
          {truncate(data.title, 50)}
        </div>
        {data.description ? (
          <div
            style={{
              display: "flex",
              fontSize: 24,
              fontWeight: 400,
              color: "rgba(255,255,255,0.5)",
              marginTop: 14,
              lineHeight: 1.4,
            }}
          >
            {truncate(data.description, 120)}
          </div>
        ) : null}
      </div>

      <Footer>
        {data.triggerLabel ? (
          <div style={{ display: "flex" }}>{data.triggerLabel}</div>
        ) : null}
        <div style={{ display: "flex" }}>
          {data.actionCount} {data.actionCount === 1 ? "action" : "actions"}
        </div>
      </Footer>
    </OGBase>,
    3600
  );
}

export async function generateWorkflowOGImage(
  workflowId: string
): Promise<Response> {
  try {
    const rows = await db
      .select({
        name: workflows.name,
        description: workflows.description,
        nodes: workflows.nodes,
        edges: workflows.edges,
        visibility: workflows.visibility,
      })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);

    const workflow = rows[0];

    if (!workflow) {
      return new Response("Workflow not found", { status: 404 });
    }

    // Unlisted workflows are link-shareable, so they also get an OG preview.
    // Only private workflows refuse OG rendering.
    if (workflow.visibility === "private") {
      return new Response("Workflow is private", { status: 403 });
    }

    const data = prepareRenderData({
      name: workflow.name,
      description: workflow.description,
      // biome-ignore lint/suspicious/noExplicitAny: JSONB column type from Drizzle schema
      nodes: workflow.nodes as any[],
      // biome-ignore lint/suspicious/noExplicitAny: JSONB column type from Drizzle schema
      edges: workflow.edges as any[],
    });

    return await renderWorkflowOG(data);
  } catch {
    return new Response("Failed to generate image", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Protocol OG
// ---------------------------------------------------------------------------

export async function generateProtocolOGImage(slug: string): Promise<Response> {
  await import("@/protocols");
  const { getProtocol } = await import("@/lib/protocol-registry");
  const { getChainName } = await import("@/lib/chain-utils");

  const protocol = getProtocol(slug);

  if (!protocol) {
    return new Response("Protocol not found", { status: 404 });
  }

  const allChains = new Set<string>();
  for (const contract of Object.values(protocol.contracts)) {
    for (const chain of Object.keys(contract.addresses)) {
      allChains.add(chain);
    }
  }
  const chains = Array.from(allChains);

  const writeActions = protocol.actions.filter(
    (a) => a.type === "write"
  ).length;
  const readActions = protocol.actions.filter((a) => a.type === "read").length;

  const cleanDescription = protocol.description.replace(/ -- /g, ". ");

  return await renderOGImage(
    <OGBase>
      {/* Top content */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "60%",
          display: "flex",
          flexDirection: "column",
          padding: "40px 56px 0",
        }}
      >
        <Header />
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            marginTop: 36,
          }}
        >
          {/* biome-ignore lint/a11y/useAltText: OG image render context */}
          {/* biome-ignore lint/performance/noImgElement: Satori requires img */}
          <img
            height={58}
            src={ICON_GLOBE}
            style={{ width: 58, height: 58 }}
            width={58}
          />
          <div
            style={{
              display: "flex",
              fontSize: 58,
              fontWeight: 600,
              color: "#ffffff",
              lineHeight: 1.15,
            }}
          >
            {protocol.name}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            fontWeight: 400,
            color: "rgba(255,255,255,0.5)",
            marginTop: 14,
            lineHeight: 1.4,
          }}
        >
          {truncate(cleanDescription, 120)}
        </div>
      </div>

      {/* Chain badges */}
      <div
        style={{
          position: "absolute",
          top: 330,
          left: 56,
          right: 56,
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        {chains.map((chainId) => (
          <div
            key={chainId}
            style={{
              display: "flex",
              padding: "12px 24px",
              borderRadius: 12,
              backgroundColor: CARD_COLOR,
              border: `1.5px solid ${NODE_BORDER_GREEN}`,
              fontSize: 18,
              fontWeight: 400,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            {getChainName(chainId)}
          </div>
        ))}
      </div>

      <Footer>
        <div style={{ display: "flex" }}>
          {protocol.actions.length}{" "}
          {protocol.actions.length === 1 ? "action" : "actions"}
        </div>
        {writeActions > 0 && (
          <div style={{ display: "flex" }}>
            {writeActions} {writeActions === 1 ? "write" : "writes"}
          </div>
        )}
        {readActions > 0 && (
          <div style={{ display: "flex" }}>
            {readActions} {readActions === 1 ? "read" : "reads"}
          </div>
        )}
      </Footer>
    </OGBase>,
    3600
  );
}

// ---------------------------------------------------------------------------
// Shared layout components
// ---------------------------------------------------------------------------

function Header(): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        {/* biome-ignore lint/a11y/useAltText: OG image render context */}
        {/* biome-ignore lint/performance/noImgElement: Satori requires img */}
        <img
          height={32}
          src={LOGO_SVG}
          style={{ width: 20, height: 32 }}
          width={20}
        />
        <div
          style={{
            display: "flex",
            fontSize: 22,
            fontWeight: 400,
            color: "rgba(255,255,255,0.85)",
          }}
        >
          KeeperHub
        </div>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 24,
          color: "rgba(255,255,255,0.3)",
        }}
      >
        {OG_WATERMARK_HOST}
      </div>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "18%",
        display: "flex",
        flexDirection: "row",
        alignItems: "flex-end",
        padding: "0 56px 36px",
        gap: 32,
        fontSize: 20,
        fontWeight: 400,
        color: "rgba(255,255,255,0.45)",
      }}
    >
      {children}
    </div>
  );
}
