# Token Reference

Master map of all CSS variables in the KeeperHub design system.
Source: `specs/design-system/tokens.css`, `app/globals.css`

## Layer 1: Primitive Tokens (--ds-*)

Never reference directly in components. These are raw values.

### Neutral Colors

| Variable | Value |
|---|---|
| `--ds-neutral-50` | `oklch(0.9842 0.0034 247.86)` |
| `--ds-neutral-100` | `oklch(0.9683 0.0069 247.9)` |
| `--ds-neutral-200` | `oklch(0.9288 0.0126 255.51)` |
| `--ds-neutral-300` | `oklch(0.7107 0.0351 256.79)` |
| `--ds-neutral-400` | `oklch(0.5544 0.0407 257.42)` |
| `--ds-neutral-500` | `oklch(0.4455 0.0374 257.28)` |
| `--ds-neutral-600` | `oklch(0.3717 0.0392 257.29)` |
| `--ds-neutral-700` | `oklch(0.2795 0.0368 260.03)` |
| `--ds-neutral-800` | `oklch(0.2101 0.0318 264.66)` |

### Brand Colors

| Variable | Value | When to use |
|---|---|---|
| `--ds-green-400` | `oklch(0.8671 0.2514 147.76)` | Brand green (light variant) |
| `--ds-green-500` | `oklch(0.7402 0.2136 147.89)` | Brand green (dark variant) |
| `--ds-green-accent` | `#09fd67` | Bright accent green |
| `--ds-green-accent-10` | `#09fd671a` | Accent at 10% opacity |
| `--ds-green-logo` | `#00FF4F` | Logo only |

### State Colors

| Variable | Value | When to use |
|---|---|---|
| `--ds-red-500` | `oklch(0.577 0.245 27.325)` | Error/destructive (light) |
| `--ds-red-500-dark` | `oklch(0.65 0.25 29)` | Error/destructive (dark) |

### Chart Colors

| Variable | Value |
|---|---|
| `--ds-chart-orange` | `oklch(0.646 0.222 41.116)` |
| `--ds-chart-teal` | `oklch(0.6 0.118 184.704)` |
| `--ds-chart-slate` | `oklch(0.398 0.07 227.392)` |
| `--ds-chart-yellow` | `oklch(0.828 0.189 84.429)` |
| `--ds-chart-gold` | `oklch(0.769 0.188 70.08)` |
| `--ds-chart-purple-dark` | `oklch(0.488 0.243 264.376)` |
| `--ds-chart-green-dark` | `oklch(0.696 0.17 162.48)` |
| `--ds-chart-violet-dark` | `oklch(0.627 0.265 303.9)` |
| `--ds-chart-coral-dark` | `oklch(0.645 0.246 16.439)` |

### Hub Surface Colors

| Variable | Value | When to use |
|---|---|---|
| `--ds-hub-surface-1` | `#1a2230` | Dark card backgrounds |
| `--ds-hub-surface-2` | `#2a3342` | Dark icon containers |
| `--ds-hub-surface-3` | `#243548` | Gradient centers |
| `--ds-hub-surface-hover` | `#354155` | Dark hover states |
| `--ds-hub-overlay` | `#171f2e` | Dark overlays |

### Blue (Template Badge)

| Variable | Value | When to use |
|---|---|---|
| `--ds-blue-500` | `rgb(37, 99, 235)` | Badge text (light) |
| `--ds-blue-400` | `rgb(96, 165, 250)` | Badge text (dark) |
| `--ds-blue-500-10` | `rgba(59, 130, 246, 0.1)` | Badge background |
| `--ds-blue-500-20` | `rgba(59, 130, 246, 0.2)` | Badge border |

### Palette (Project/Tag Colors)

| Variable | Value |
|---|---|
| `--ds-palette-blue` | `#4A90D9` |
| `--ds-palette-violet` | `#7B61FF` |
| `--ds-palette-rose` | `#E06C75` |
| `--ds-palette-green` | `#98C379` |
| `--ds-palette-amber` | `#E5C07B` |
| `--ds-palette-cyan` | `#56B6C2` |
| `--ds-palette-purple` | `#C678DD` |
| `--ds-palette-orange` | `#D19A66` |

### Spacing

| Variable | Value | px |
|---|---|---|
| `--ds-space-0` | `0` | 0 |
| `--ds-space-px` | `1px` | 1 |
| `--ds-space-0-5` | `0.125rem` | 2 |
| `--ds-space-1` | `0.25rem` | 4 |
| `--ds-space-1-5` | `0.375rem` | 6 |
| `--ds-space-2` | `0.5rem` | 8 |
| `--ds-space-3` | `0.75rem` | 12 |
| `--ds-space-4` | `1rem` | 16 |
| `--ds-space-5` | `1.25rem` | 20 |
| `--ds-space-6` | `1.5rem` | 24 |
| `--ds-space-8` | `2rem` | 32 |
| `--ds-space-10` | `2.5rem` | 40 |
| `--ds-space-12` | `3rem` | 48 |
| `--ds-space-16` | `4rem` | 64 |

### Typography

| Variable | Value |
|---|---|
| `--ds-font-sans` | Anek Latin, system-ui, sans-serif |
| `--ds-font-mono` | Geist Mono, ui-monospace, monospace |
| `--ds-text-2xs` | `0.625rem` (10px) |
| `--ds-text-xs` | `0.6875rem` (11px) |
| `--ds-text-sm` | `0.75rem` (12px) |
| `--ds-text-base` | `0.875rem` (14px) |
| `--ds-text-md` | `1rem` (16px) |
| `--ds-text-lg` | `1.125rem` (18px) |
| `--ds-text-xl` | `1.25rem` (20px) |
| `--ds-text-2xl` | `1.5rem` (24px) |
| `--ds-text-3xl` | `1.875rem` (30px) |
| `--ds-weight-normal` | 400 |
| `--ds-weight-medium` | 500 |
| `--ds-weight-semibold` | 600 |
| `--ds-weight-bold` | 700 |
| `--ds-leading-tight` | 1.15 |
| `--ds-leading-snug` | 1.4 |
| `--ds-leading-normal` | 1.5 |
| `--ds-leading-relaxed` | 1.6 |
| `--ds-leading-loose` | 1.7 |
| `--ds-tracking-tight` | -1.5px |
| `--ds-tracking-snug` | -0.75px |
| `--ds-tracking-normal` | 0 |
| `--ds-tracking-wide` | 0.5px |

### Border Radius

| Variable | Value |
|---|---|
| `--ds-radius-none` | 0 |
| `--ds-radius-sm` | `0.375rem` (6px) |
| `--ds-radius-md` | `0.5rem` (8px) |
| `--ds-radius-lg` | `0.625rem` (10px) |
| `--ds-radius-xl` | `1.025rem` (~16px) |
| `--ds-radius-full` | 9999px |

### Elevation

| Variable | Value |
|---|---|
| `--ds-shadow-sm` | `0 1px 2px 0 rgba(0,0,0,0.05)` |
| `--ds-shadow-md` | `0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)` |
| `--ds-shadow-lg` | `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)` |
| `--ds-shadow-xl` | `0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)` |
| `--ds-shadow-overlay` | `0 8px 24px rgba(0,0,0,0.3)` |
| `--ds-shadow-focus` | `0 0 0 2px rgba(6,177,113,0.15)` |

### Z-Index

| Variable | Value | When to use |
|---|---|---|
| `--ds-z-below` | -10 | Background decorations |
| `--ds-z-base` | 0 | Default layer |
| `--ds-z-raised` | 10 | Slightly elevated (handles) |
| `--ds-z-controls` | 20 | Workflow controls, React Flow handles |
| `--ds-z-flyout` | 30 | Flyout panels |
| `--ds-z-sidebar` | 40 | Navigation sidebar overlay |
| `--ds-z-modal` | 50 | Modals, dialogs |
| `--ds-z-toast` | 60 | Toast notifications |

### Motion

| Variable | Value | When to use |
|---|---|---|
| `--ds-duration-fast` | 100ms | Opacity, color micro-changes |
| `--ds-duration-normal` | 150ms | Default transitions |
| `--ds-duration-slow` | 200ms | Standard UI animations |
| `--ds-duration-slower` | 300ms | Complex enter/exit |
| `--ds-easing-default` | ease | General purpose |
| `--ds-easing-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Enter/exit |
| `--ds-easing-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Bouncy/playful |

### Layout

| Variable | Value | When to use |
|---|---|---|
| `--ds-header-height` | 60px | Header offset calculations |
| `--ds-sidebar-strip-width` | 32px | Collapsed sidebar strip |
| `--ds-flyout-width` | 280px | Flyout panel width |
| `--ds-drawer-width` | 220px | Analytics drawer width |

---

## Layer 2: Semantic Aliases

These are what components should reference. See `specs/design-system/tokens.css` for the full list with fallback values.

### Quick Reference by Use Case

| I need... | Use this token | Tailwind class |
|---|---|---|
| Page background | `--background` | `bg-background` |
| Primary text | `--foreground` | `text-foreground` |
| Muted text | `--muted-foreground` | `text-muted-foreground` |
| Card surface | `--card` | `bg-card` |
| Default border | `--border` | `border-border` |
| Focus ring | `--ring` | `ring-ring` |
| Primary button bg | `--primary` | `bg-primary` |
| Primary button text | `--primary-foreground` | `text-primary-foreground` |
| Destructive action | `--destructive` | `bg-destructive` |
| Brand green | `--keeperhub-green` | `bg-keeperhub-green` / `text-keeperhub-green` |
| Brand green (darker) | `--keeperhub-green-dark` | `bg-keeperhub-green-dark` |
| Green accent text | `--color-text-accent` | -- (use var()) |
| Green accent bg | `--color-bg-accent` | -- (use var()) |
| Hub dark card | `--color-hub-card` | -- (use var()) |
| Hub icon container | `--color-hub-icon-bg` | -- (use var()) |
| Template badge bg | `--color-badge-blue-bg` | -- (use var()) |
| Template badge text | `--color-badge-blue-text` | -- (use var()) |
| Header offset | `--header-height` | `top-[var(--header-height)]` |
| Flyout width | `--flyout-width` | `w-[var(--flyout-width)]` |

### Tokens Not Yet in Tailwind Theme

These tokens from `tokens.css` are not yet mapped in `@theme inline`. Use `var()` directly until they are added:

- All `--color-hub-*` tokens
- All `--color-badge-*` tokens
- All `--color-text-*` semantic tokens
- All `--color-bg-*` semantic tokens
- All `--space-*` tokens (use Tailwind spacing classes instead)
- All `--shadow-*` tokens (use Tailwind shadow classes instead)
- All `--z-*` tokens (use Tailwind z-index classes instead)
- All `--duration-*` and `--easing-*` tokens
- All `--ds-*` layout tokens
