/**
 * Shared color palette for projects and tags.
 * These are stored as hex values in the database.
 * The corresponding design tokens are defined in specs/design-system/tokens.css
 * under the --ds-palette-* variables.
 */
export const COLOR_PALETTE: string[] = [
  "#4A90D9",
  "#7B61FF",
  "#E06C75",
  "#98C379",
  "#E5C07B",
  "#56B6C2",
  "#C678DD",
  "#D19A66",
];

/**
 * Default fallback color for projects/tags without an assigned color.
 * Maps to --color-text-muted in the design system.
 */
export const DEFAULT_PROJECT_COLOR = "var(--color-text-muted)";
