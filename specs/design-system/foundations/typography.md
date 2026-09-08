# Typography

Category: Foundation
Status: Active
Source: `specs/design-system/tokens.css`, `app/globals.css`

## Font Families

| Token | Stack | Usage |
|---|---|---|
| `--font-sans` / `--ds-font-sans` | Anek Latin, system-ui, sans-serif | All UI text |
| `--font-mono` / `--ds-font-mono` | Geist Mono, ui-monospace, monospace | Code, addresses, data |

Fonts are loaded via `next/font` in the layout and applied via CSS variables `--font-anek-latin` and `--font-geist-mono`.

## Type Scale

| Token | Size | px | Tailwind | Usage |
|---|---|---|---|---|
| `--ds-text-2xs` | `0.625rem` | 10 | `text-[0.625rem]` | Badges, tiny labels |
| `--ds-text-xs` | `0.6875rem` | 11 | `text-[0.6875rem]` | Small badges |
| `--ds-text-sm` | `0.75rem` | 12 | `text-xs` | Table headers, captions |
| `--ds-text-base` | `0.875rem` | 14 | `text-sm` | Body text, table cells |
| `--ds-text-md` | `1rem` | 16 | `text-base` | Default/base size |
| `--ds-text-lg` | `1.125rem` | 18 | `text-lg` | Small headings |
| `--ds-text-xl` | `1.25rem` | 20 | `text-xl` | Section headings |
| `--ds-text-2xl` | `1.5rem` | 24 | `text-2xl` | Page headings |
| `--ds-text-3xl` | `1.875rem` | 30 | `text-3xl` | Hero headings |

## Font Weights

| Token | Value | Tailwind | Usage |
|---|---|---|---|
| `--ds-weight-normal` | 400 | `font-normal` | Body text |
| `--ds-weight-medium` | 500 | `font-medium` | Labels, badge text |
| `--ds-weight-semibold` | 600 | `font-semibold` | Subheadings, strong emphasis |
| `--ds-weight-bold` | 700 | `font-bold` | Main headings |

## Line Heights

| Token | Value | Tailwind | Usage |
|---|---|---|---|
| `--ds-leading-tight` | 1.15 | `leading-tight` | Large headings |
| `--ds-leading-snug` | 1.4 | `leading-snug` | Subheadings |
| `--ds-leading-normal` | 1.5 | `leading-normal` | Default |
| `--ds-leading-relaxed` | 1.6 | `leading-relaxed` | Body text |
| `--ds-leading-loose` | 1.7 | `leading-loose` | Long-form content |

## Letter Spacing

| Token | Value | Usage |
|---|---|---|
| `--ds-tracking-tight` | -1.5px | Hero headings |
| `--ds-tracking-snug` | -0.75px | Section headings |
| `--ds-tracking-normal` | 0 | Default |
| `--ds-tracking-wide` | 0.5px | Uppercase labels, table headers |

## Heading Hierarchy

| Level | Size | Weight | Tracking | Leading |
|---|---|---|---|---|
| h1 | `text-3xl` | `font-bold` | `tracking-tight` | `leading-tight` |
| h2 | `text-2xl` | `font-bold` | `tracking-snug` | `leading-snug` |
| h3 | `text-xl` | `font-semibold` | `tracking-normal` | `leading-snug` |
| h4 | `text-lg` | `font-semibold` | `tracking-normal` | `leading-normal` |

## Rules

1. Never use `text-[10px]` or `text-[11px]` -- use `text-[0.625rem]` or `text-[0.6875rem]` with a comment referencing the token name
2. Prefer Tailwind type classes (`text-sm`, `font-medium`) over inline styles
3. Body text should use `text-sm` (14px), not `text-base` (16px) -- the app is information-dense
4. Monospace font is for code, blockchain addresses, and numeric data only
