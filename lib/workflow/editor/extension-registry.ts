/**
 * Extension Registry
 *
 * Provides extension points for KeeperHub (or other forks) to inject
 * custom components without modifying base template files.
 *
 * This enables clean upstream merges while allowing customization.
 */

import type { ReactNode } from "react";
import type { ActionConfigFieldBase } from "@/plugins/registry";

// ============================================================================
// Custom Field Renderers (for action-config-renderer.tsx)
// ============================================================================

type FieldRendererContext = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
};

type CustomFieldRenderer = (context: FieldRendererContext) => ReactNode | null;

const customFieldRenderers: Map<string, CustomFieldRenderer> = new Map();

/**
 * Register a custom field renderer for a specific field type
 * @param fieldType - The field type to handle (e.g., "abi-with-auto-fetch")
 * @param renderer - Function that renders the field
 */
export function registerFieldRenderer(
  fieldType: string,
  renderer: CustomFieldRenderer
): void {
  customFieldRenderers.set(fieldType, renderer);
}

/**
 * Get a custom field renderer for a field type
 */
export function getCustomFieldRenderer(
  fieldType: string
): CustomFieldRenderer | undefined {
  return customFieldRenderers.get(fieldType);
}

/**
 * Check if a custom field renderer exists for a field type
 */
export function hasCustomFieldRenderer(fieldType: string): boolean {
  return customFieldRenderers.has(fieldType);
}

// ============================================================================
// Custom Integration Form Handlers (for integration-form-dialog.tsx)
// ============================================================================

type IntegrationFormContext = {
  integrationType: string;
  isEditMode: boolean;
  config: Record<string, unknown>;
  updateConfig: (key: string, value: string) => void;
  onSuccess?: (integrationId: string) => void;
  closeAll?: () => void;
};

type CustomIntegrationFormHandler = (
  context: IntegrationFormContext
) => ReactNode | null;

const customIntegrationFormHandlers: Map<string, CustomIntegrationFormHandler> =
  new Map();

/**
 * Register a custom form handler for a specific integration type
 * @param integrationType - The integration type to handle (e.g., "web3")
 * @param handler - Function that renders the custom form
 */
export function registerIntegrationFormHandler(
  integrationType: string,
  handler: CustomIntegrationFormHandler
): void {
  customIntegrationFormHandlers.set(integrationType, handler);
}

/**
 * Get a custom integration form handler
 */
export function getCustomIntegrationFormHandler(
  integrationType: string
): CustomIntegrationFormHandler | undefined {
  return customIntegrationFormHandlers.get(integrationType);
}

/**
 * Check if a custom integration form handler exists
 */
export function hasCustomIntegrationFormHandler(
  integrationType: string
): boolean {
  return customIntegrationFormHandlers.has(integrationType);
}

// ============================================================================
// Branding Registry (for logos, app name, etc.)
// ============================================================================

type LogoComponent = (props: { className?: string }) => ReactNode;

const brandingRegistry: {
  logo: LogoComponent | null;
  appName: string;
} = {
  logo: null,
  appName: "Workflow Builder",
};

/**
 * Register custom branding (logo, app name)
 */
export function registerBranding(branding: {
  logo?: LogoComponent;
  appName?: string;
}): void {
  if (branding.logo) {
    brandingRegistry.logo = branding.logo;
  }
  if (branding.appName) {
    brandingRegistry.appName = branding.appName;
  }
}

/**
 * Get the registered logo component (or null for default)
 */
export function getCustomLogo(): LogoComponent | null {
  return brandingRegistry.logo;
}

/**
 * Get the app name
 */
export function getAppName(): string {
  return brandingRegistry.appName;
}

// ============================================================================
// Component Slots (for injecting components into specific UI locations)
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: Generic component type
type ComponentSlotRenderer<P = any> = (props: P) => ReactNode;

// biome-ignore lint/suspicious/noExplicitAny: Generic component registry
const componentSlots: Map<string, ComponentSlotRenderer<any>> = new Map();

/**
 * Register a component for a specific UI slot
 * @param slotName - The slot name (e.g., "user-menu-wallet-dialog")
 * @param renderer - Function that renders the component with props
 */
export function registerComponentSlot<P>(
  slotName: string,
  renderer: ComponentSlotRenderer<P>
): void {
  componentSlots.set(slotName, renderer);
}

/**
 * Get a component for a specific slot
 */
export function getComponentSlot<P>(
  slotName: string
): ComponentSlotRenderer<P> | undefined {
  return componentSlots.get(slotName);
}

/**
 * Check if a component slot is registered
 */
export function hasComponentSlot(slotName: string): boolean {
  return componentSlots.has(slotName);
}
