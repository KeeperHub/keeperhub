"use client";

import { ConnectAgentPanel } from "@/components/agent/connect-agent-panel";
import { Overlay } from "./overlay";
import type { OverlayComponentProps } from "./types";

export function ConnectAgentOverlay({
  overlayId,
}: OverlayComponentProps): React.ReactElement {
  return (
    <Overlay
      description="Point your AI agent at KeeperHub over MCP, then drive workflows and wallets from your editor. Every client signs in through the browser, so no API key is required."
      overlayId={overlayId}
      title="Connect your AI agent"
    >
      <ConnectAgentPanel />
    </Overlay>
  );
}
