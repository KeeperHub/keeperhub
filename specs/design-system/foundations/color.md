# Color

Category: Foundation
Status: Active
Source: `app/globals.css`, `specs/design-system/tokens.css`

## Color Space

All theme colors use **OKLCh** (Oklch Lightness, Chroma, Hue). OKLCh provides perceptually uniform color manipulation -- adjusting lightness by the same amount across colors produces visually consistent results.

Format: `oklch(L C H)` where L = 0-1, C = 0-0.4, H = 0-360.

## Semantic Color Roles

### Text

| Token | Light Mode | Dark Mode | Usage |
|---|---|---|---|
| `--foreground` | `oklch(0.2101 0.0318 264.66)` | `oklch(0.9288 0.0126 255.51)` | Primary text |
| `--muted-foreground` | `oklch(0.5544 0.0407 257.42)` | `oklch(0.5544 0.0407 257.42)` | Secondary/helper text |
| `--primary-foreground` | `oklch(0.9842 0.0034 247.86)` | `oklch(0.2101 0.0318 264.66)` | Text on primary surfaces |
| `--accent-foreground` | `oklch(0.2101 0.0318 264.66)` | `oklch(0.9288 0.0126 255.51)` | Text on accent surfaces |
| `--keeperhub-green` | `oklch(0.8671 0.2514 147.76)` | same | Brand accent text |

### Background

| Token | Light Mode | Dark Mode | Usage |
|---|---|---|---|
| `--background` | `oklch(0.9842 0.0034 247.86)` | `oklch(0.2101 0.0318 264.66)` | Page background |
| `--card` | `oklch(0.9683 0.0069 247.9)` | `oklch(0.2795 0.0368 260.03)` | Card/elevated surfaces |
| `--popover` | `oklch(0.9683 0.0069 247.9)` | `oklch(0.2795 0.0368 260.03)` | Popovers, dropdowns |
| `--muted` | `oklch(0.9288 0.0126 255.51)` | `oklch(0.3717 0.0392 257.29)` | Subdued surfaces |
| `--accent` | `oklch(0.9288 0.0126 255.51)` | `oklch(0.3717 0.0392 257.29)` | Highlighted surfaces |
| `--secondary` | `oklch(0.9842 0.0034 247.86)` | `oklch(0.2101 0.0318 264.66)` | Secondary button bg |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.65 0.25 29)` | Error/danger states |

### Border

| Token | Light Mode | Dark Mode | Usage |
|---|---|---|---|
| `--border` | `oklch(0.9288 0.0126 255.51)` | `oklch(0.3717 0.0392 257.29)` | Default borders |
| `--input` | `oklch(0.9288 0.0126 255.51)` | `oklch(0.3717 0.0392 257.29)` | Input field borders |
| `--ring` | `oklch(0.7107 0.0351 256.79)` | `oklch(0.4455 0.0374 257.28)` | Focus rings |

### Charts

| Token | Light Mode | Dark Mode |
|---|---|---|
| `--chart-1` | `oklch(0.646 0.222 41.116)` | `oklch(0.488 0.243 264.376)` |
| `--chart-2` | `oklch(0.6 0.118 184.704)` | `oklch(0.696 0.17 162.48)` |
| `--chart-3` | `oklch(0.398 0.07 227.392)` | `oklch(0.769 0.188 70.08)` |
| `--chart-4` | `oklch(0.828 0.189 84.429)` | `oklch(0.627 0.265 303.9)` |
| `--chart-5` | `oklch(0.769 0.188 70.08)` | `oklch(0.645 0.246 16.439)` |

### Sidebar

| Token | Light Mode | Dark Mode |
|---|---|---|
| `--sidebar` | `oklch(0.9842 ...)` | `oklch(0.2101 ...)` |
| `--sidebar-foreground` | `oklch(0.5544 ...)` | `oklch(0.5544 ...)` |
| `--sidebar-primary` | `oklch(0.2101 ...)` | `oklch(0.9288 ...)` |
| `--sidebar-accent` | `oklch(0.9683 ...)` | `oklch(0.2101 ...)` |
| `--sidebar-border` | `oklch(0.9288 ...)` | `oklch(0.3717 ...)` |
| `--sidebar-ring` | `oklch(0.7107 ...)` | `oklch(0.4455 ...)` |

### Brand

| Token | Value | Usage |
|---|---|---|
| `--keeperhub-green` | `oklch(0.8671 0.2514 147.76)` | Primary brand green |
| `--keeperhub-green-dark` | `oklch(0.7402 0.2136 147.89)` | Darker brand green |
| `--ds-green-accent` | `#09fd67` | Bright accent (hub badges, active states) |
| `--ds-green-accent-10` | `#09fd671a` | Accent at 10% opacity (backgrounds) |

### Hub Surfaces (dark-only)

| Token | Value | Usage |
|---|---|---|
| `--ds-hub-surface-1` | `#1a2230` | Card backgrounds |
| `--ds-hub-surface-2` | `#2a3342` | Icon containers |
| `--ds-hub-surface-3` | `#243548` | Gradient centers |
| `--ds-hub-surface-hover` | `#354155` | Hover states |
| `--ds-hub-overlay` | `#171f2e` | Dark overlays |

### Palette (project/tag colors)

| Token | Value |
|---|---|
| `--ds-palette-blue` | `#4A90D9` |
| `--ds-palette-violet` | `#7B61FF` |
| `--ds-palette-rose` | `#E06C75` |
| `--ds-palette-green` | `#98C379` |
| `--ds-palette-amber` | `#E5C07B` |
| `--ds-palette-cyan` | `#56B6C2` |
| `--ds-palette-purple` | `#C678DD` |
| `--ds-palette-orange` | `#D19A66` |

## Tailwind Usage

Colors are mapped to Tailwind via `@theme inline` in `app/globals.css`:

```
bg-background       -> var(--background)
text-foreground      -> var(--foreground)
bg-primary           -> var(--primary)
text-muted-foreground -> var(--muted-foreground)
border-border        -> var(--border)
bg-destructive       -> var(--destructive)
bg-keeperhub-green   -> var(--keeperhub-green)
```

## Rules

1. Never use raw hex/rgb/oklch values in component code
2. Always reference semantic tokens (`--foreground`, `--border`, etc.)
3. For hub-specific dark surfaces, use `--color-hub-*` tokens
4. For badge colors, use `--color-badge-*` tokens
5. The project/tag palette array should import from a shared constant, not be duplicated
