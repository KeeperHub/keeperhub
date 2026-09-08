# Border Radius

Category: Foundation
Status: Active
Source: `specs/design-system/tokens.css`, `app/globals.css`

## Scale

Base radius: **0.625rem** (10px), defined as `--radius` in globals.css.

| Token | Value | px | Tailwind | Usage |
|---|---|---|---|---|
| `--radius-sm` | `calc(var(--radius) - 4px)` | ~6 | `rounded-sm` | Small elements (badges, chips) |
| `--radius-md` | `calc(var(--radius) - 2px)` | ~8 | `rounded-md` | Inputs, buttons |
| `--radius-lg` | `var(--radius)` | 10 | `rounded-lg` | Cards, modals, panels |
| `--radius-xl` | `calc(var(--radius) + 4px)` | ~14 | `rounded-xl` | Large cards, hero elements |
| `--radius-full` | `9999px` | - | `rounded-full` | Circles, pills, avatars |

## How It Works

The `--radius` CSS variable is the single source of truth. All other radius values are computed from it. Changing `--radius` globally adjusts the entire rounding feel:

```css
:root {
  --radius: 0.625rem;  /* 10px -- current value */
}
```

The Tailwind theme maps these in `@theme inline`:

```css
--radius-sm: calc(var(--radius) - 4px);
--radius-md: calc(var(--radius) - 2px);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) + 4px);
```

## Rules

1. Never use hardcoded border-radius values (`3px`, `4px`, `10px`, `20px`)
2. Always use Tailwind classes: `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-full`
3. For elements that need `rounded-none`, that is also acceptable
4. The search input in docs-site uses `border-radius: 20px` -- this should be `rounded-full` instead
