# Motion / Transitions

Category: Foundation
Status: Active
Source: `specs/design-system/tokens.css`, `app/globals.css`

## Duration Scale

| Token | Value | Usage |
|---|---|---|
| `--duration-fast` | `100ms` | Micro-interactions (opacity, color) |
| `--duration-normal` | `150ms` | Default transitions (borders, strokes) |
| `--duration-slow` | `200ms` | Standard UI transitions (slides, fades) |
| `--duration-slower` | `300ms` | Complex animations (modals, drawers) |

## Easing Functions

| Token | Value | Usage |
|---|---|---|
| `--easing-default` | `ease` | General-purpose |
| `--easing-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Enter/exit transitions |
| `--easing-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful/bouncy interactions |

## Custom Animations

Defined in `app/globals.css`:

### flyout-in

Slide-in from the left with fade. Used for flyout panel entry.

```css
@keyframes flyout-in {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
```

### dashdraw

Animated dashed line drawing. Used for workflow edge connections.

```css
@keyframes dashdraw {
  from { stroke-dashoffset: 10; }
  to   { stroke-dashoffset: 0; }
}
```

## Transition Patterns

### Color transitions

```css
transition: color var(--duration-slow) var(--easing-default);
/* equivalent to: transition: color 0.2s ease; */
```

### Stroke transitions (workflow connectors)

```css
transition: stroke var(--duration-normal);
/* equivalent to: transition: stroke 150ms; */
```

### Interactive element transitions

The docs-site applies a global transition to all interactive elements:

```css
a, button, input, [role="button"] {
  transition: all 0.2s ease;
}
```

This should use tokens: `transition: all var(--duration-slow) var(--easing-default)`.

## tw-animate-css

The project imports `tw-animate-css` for Tailwind animation utilities. This provides classes like `animate-in`, `animate-out`, `fade-in`, `slide-in-from-left`, etc. Use these for component mount/unmount animations.

## Rules

1. Never hardcode durations (`150ms`, `0.2s`) -- use duration tokens
2. Never hardcode easing (`ease`, `ease-in-out`) -- use easing tokens
3. Prefer Tailwind animation classes from `tw-animate-css` for enter/exit
4. Custom `@keyframes` should be defined in `app/globals.css`, not inline
5. Use `prefers-reduced-motion` media query for accessibility when adding new animations
