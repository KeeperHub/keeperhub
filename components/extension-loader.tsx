"use client";

/**
 * KeeperHub Extension Loader
 *
 * This component loads KeeperHub extensions on the client side.
 * It should be included in the app layout to ensure extensions
 * are registered before any components that need them are rendered.
 *
 * The component renders nothing - it only triggers the import.
 */

// Import extensions to register them
import "@/lib/workflow/editor/extensions";

export function KeeperHubExtensionLoader() {
  // This component doesn't render anything
  // It just ensures the extensions module is loaded
  return null;
}
