# Spacing

Category: Foundation
Status: Active
Source: `specs/design-system/tokens.css`

## Scale

Base unit: **4px** (0.25rem). All spacing derives from multiples of 4px.

| Token | Value | px | Usage |
|---|---|---|---|
| `--space-0` | `0` | 0 | Reset |
| `--space-px` | `1px` | 1 | Hairline offsets |
| `--space-0-5` | `0.125rem` | 2 | Micro spacing (badge padding) |
| `--space-1` | `0.25rem` | 4 | Tight inner padding |
| `--space-1-5` | `0.375rem` | 6 | Small padding |
| `--space-2` | `0.5rem` | 8 | Default inner padding |
| `--space-3` | `0.75rem` | 12 | Medium padding |
| `--space-4` | `1rem` | 16 | Standard padding/gap |
| `--space-5` | `1.25rem` | 20 | Comfortable padding |
| `--space-6` | `1.5rem` | 24 | Section padding |
| `--space-8` | `2rem` | 32 | Large section gaps |
| `--space-10` | `2.5rem` | 40 | Extra large gaps |
| `--space-12` | `3rem` | 48 | Page-level spacing |
| `--space-16` | `4rem` | 64 | Major layout gaps |

## Layout Constants

| Token | Value | Usage |
|---|---|---|
| `--header-height` | `60px` | Main header bar height |
| `--sidebar-strip-width` | `32px` | Collapsed sidebar strip |
| `--flyout-width` | `280px` | Flyout panel width |
| `--drawer-width` | `220px` | Analytics drawer width |

## Tailwind Mapping

Use standard Tailwind spacing classes which map to the 4px scale:

```
p-1  -> 4px      m-1  -> 4px
p-2  -> 8px      m-2  -> 8px
p-3  -> 12px     m-3  -> 12px
p-4  -> 16px     m-4  -> 16px
p-6  -> 24px     m-6  -> 24px
p-8  -> 32px     m-8  -> 32px
gap-4 -> 16px    gap-6 -> 24px
```

## Rules

1. Never use arbitrary pixel values in Tailwind (e.g., `p-[13px]`). Map to the nearest scale step.
2. Layout constants (`--header-height`, `--flyout-width`, etc.) must use tokens, not hardcoded numbers.
3. Use `top-[var(--header-height)]` instead of `top-[60px]`.
4. For component-specific fixed dimensions (card widths, chart heights), use the spacing scale or define a layout constant in tokens.css.
5. Viewport-relative values (`80vh`, `100dvh`) are acceptable and do not need tokens.
