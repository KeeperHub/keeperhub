# Elevation / Shadows

Category: Foundation
Status: Active
Source: `specs/design-system/tokens.css`

## Shadow Scale

| Token | Value | Tailwind | Usage |
|---|---|---|---|
| `--shadow-sm` | `0 1px 2px 0 rgba(0,0,0,0.05)` | `shadow-sm` | Subtle lift (buttons, cards at rest) |
| `--shadow-md` | `0 4px 6px -1px rgba(0,0,0,0.1), ...` | `shadow-md` | Moderate elevation (dropdowns) |
| `--shadow-lg` | `0 10px 15px -3px rgba(0,0,0,0.1), ...` | `shadow-lg` | High elevation (flyout panels, modals) |
| `--shadow-xl` | `0 20px 25px -5px rgba(0,0,0,0.1), ...` | `shadow-xl` | Maximum elevation |
| `--shadow-overlay` | `0 8px 24px rgba(0,0,0,0.3)` | -- | Overlay/dropdown menus |
| `--shadow-focus` | `0 0 0 2px rgba(6,177,113,0.15)` | -- | Focus ring shadow (green tint) |

## Elevation Hierarchy

From lowest to highest:

1. **Base** (no shadow) -- Page background, inline elements
2. **Raised** (`shadow-sm`) -- Cards, sidebar items on hover
3. **Floating** (`shadow-md`) -- Tooltips, small dropdowns
4. **Overlay** (`shadow-lg` or `shadow-overlay`) -- Flyout panels, command menus
5. **Modal** (`shadow-xl`) -- Modal dialogs, full-screen overlays

## Focus Rings

Interactive elements use a two-part focus indicator:

1. **Outline**: `outline-ring/50` (set globally via `@layer base`)
2. **Shadow**: `--shadow-focus` for inputs with green-tinted glow on `:focus`

## Rules

1. Never use hardcoded `box-shadow` values in components
2. Use Tailwind shadow classes (`shadow-sm`, `shadow-lg`) for standard elevation
3. For focus states, use `--shadow-focus` or the global outline from `@layer base`
4. Dark mode shadows should be darker -- the existing Tailwind shadows handle this automatically
5. The `!important` shadows in React Flow overrides are exempt (third-party library constraints)
