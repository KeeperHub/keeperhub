# Design System Audit

Audited: 2026-03-04
Scope: All project-owned CSS files and component files (excluding node_modules, .next, docs-site)

## Summary

| Category | Count | Severity |
|---|---|---|
| Colors (hardcoded hex/rgb/rgba) | 47 | Error |
| Spacing (hardcoded px in CSS) | 18 | Error |
| Typography (hardcoded font-size/weight) | 12 | Warning |
| Border radius (hardcoded px) | 5 | Error |
| Z-index (raw values) | 7 | Warning |
| Box shadows (hardcoded) | 4 | Warning |
| Transitions (hardcoded durations) | 3 | Warning |
| **Total** | **96** | |

## Files with Most Hardcoded Values

| File | Count | Categories |
|---|---|---|
| `keeperhub/api/og/generate-og.tsx` | 25+ | colors, shadows (OG image -- exempt) |
| `keeperhub/components/hub/protocol-strip.tsx` | 8 | colors, spacing |
| `keeperhub/components/hub/protocol-detail.tsx` | 7 | colors, spacing, typography |
| `keeperhub/components/hub/protocol-card.tsx` | 5 | colors |
| `keeperhub/components/hub/hub-hero.tsx` | 4 | colors, gradients |
| `keeperhub/components/hub/workflow-template-grid.tsx` | 4 | colors |
| `keeperhub/components/hub/workflow-node-icons.tsx` | 4 | colors |
| `app/globals.css` | 6 | colors (template-badge, React Flow) |
| `keeperhub/components/projects/project-form-dialog.tsx` | 8 | color palette array |
| `keeperhub/components/tags/tag-form-dialog.tsx` | 8 | color palette array (duplicate) |

## Detailed Findings

### Colors

#### Hardcoded in CSS (`app/globals.css`)

| Line | Value | Context |
|---|---|---|
| 192 | `rgba(255, 255, 255, 0.4)` | React Flow attribution text |
| 196 | `rgba(255, 255, 255, 0.5)` | React Flow attribution link |
| 264 | `rgba(59, 130, 246, 0.1)` | Template badge bg |
| 265 | `rgb(37, 99, 235)` | Template badge text |
| 266 | `rgba(59, 130, 246, 0.2)` | Template badge border |
| 272 | `rgb(96, 165, 250)` | Template badge text (dark) |

#### Hardcoded in Components (Tailwind arbitrary values)

| File | Value | Usage |
|---|---|---|
| hub/protocol-detail.tsx | `bg-[#09fd671a]` | Green accent bg (10% opacity) |
| hub/protocol-detail.tsx | `text-[#09fd67]` | Green accent text |
| hub/protocol-card.tsx | `bg-[#09fd671a]`, `text-[#09fd67]` | Green badges |
| hub/protocol-card.tsx | `bg-[#2a3342]` | Dark icon background |
| hub/protocol-strip.tsx | `bg-[#1a2230]` | Card background |
| hub/protocol-strip.tsx | `bg-[#2a3342]` | Icon container |
| hub/protocol-strip.tsx | `text-[#09fd67]` | Icon color |
| hub/workflow-template-grid.tsx | `bg-[#09fd671a]`, `text-[#09fd67]` | Tags |
| hub/workflow-node-icons.tsx | `bg-[#2a3342]`, `hover:bg-[#354155]` | Icon backgrounds |
| hub/hub-hero.tsx | `bg-[radial-gradient(circle,#243548...)]` | Backdrop gradient |
| hub/hub-hero.tsx | `bg-[linear-gradient(...oklch(0.2101...))]` | Bottom fade |
| app/hub/page.tsx | `bg-[#171f2e]` | Dark overlay (2x) |

#### Duplicated Color Palette Arrays

| File | Values |
|---|---|
| projects/project-form-dialog.tsx:19-27 | `#4A90D9, #7B61FF, #E06C75, #98C379, #E5C07B, #56B6C2, #C678DD, #D19A66` |
| tags/tag-form-dialog.tsx:18-26 | Identical 8-color array |

#### SVG/Icon Colors

| File | Value | Usage |
|---|---|---|
| icons/keeperhub-logo.tsx | `#00FF4F` | Logo green fill |
| ui/animated-border.tsx | `#60a5fa`, `#3b82f6` | Blue gradient stops |
| ui/animated-border.tsx | `drop-shadow(0 0 4px #3b82f6)` | Blue glow |

#### OG Image Colors (exempt -- server-rendered image, not UI)

File: `keeperhub/api/og/generate-og.tsx`
Well-organized as constants at top of file. 25+ color values for image generation.
These are intentionally hardcoded for OG image rendering and are exempt from token requirements.

### Spacing

#### Hardcoded Width/Height Constants

| File | Value | Usage |
|---|---|---|
| flyout-panel.tsx | `280` (px) | Flyout width |
| flyout-panel.tsx | `32` (px) | Strip width |
| analytics/project-drawer.tsx | `220` (px) | Drawer width |
| analytics/project-drawer.tsx | `32` (px) | Strip width |

#### Arbitrary Tailwind Spacing

| File | Class | Notes |
|---|---|---|
| hub/featured-carousel.tsx | `w-[280px]`, `h-[140px]` | Card dimensions |
| hub/protocol-strip.tsx | `w-[340px]` | Strip card width |
| hub/protocol-detail.tsx | `w-[260px]`, `h-[130px]` | Detail card dimensions |
| organization/org-switcher.tsx | `w-[200px]` (3x) | Switcher width |
| organization/manage-orgs-modal.tsx | `w-[120px]`, `w-[130px]` | Column widths |
| onboarding/organization-setup.tsx | `w-[400px]` (3x) | Setup form width |
| workflow/condition-query-builder.tsx | `w-[120px]` (2x) | Field widths |
| address-book/save-address-button.tsx | `h-[38px]` | Button height |

#### Hardcoded Spacing in CSS

| File | Line | Value | Context |
|---|---|---|---|
| app/globals.css | 163 | `translateX(-6px)` | Flyout animation |
| app/globals.css | 184 | `2px 4px` | React Flow attribution padding |
| app/globals.css | 224-225 | `12px` | React Flow handle size |
| app/globals.css | 240-241 | `44px` | Mobile touch target |
| app/globals.css | 246 | `-0.5px` | Handle position |
| app/globals.css | 267-268 | `1px 4px`, `3px` | Template badge padding/radius |

### Typography

| File | Value | Context |
|---|---|---|
| app/globals.css:187 | `10px` | React Flow attribution font-size |
| hub/protocol-detail.tsx | `text-[10px]` | Badge text (multiple) |
| hub/protocol-strip.tsx | `text-[11px]` | Strip badge text |
| hub/protocol-card.tsx | `text-[10px]` | Card badge text |
| onboarding/getting-started-checklist.tsx | `text-[10px]` | Checklist label |
| overlays/wallet-overlay.tsx | `text-[10px]` | Address label |

### Border Radius

| File | Line | Value |
|---|---|---|
| app/globals.css | 267 | `3px` (template badge) |
| app/globals.css (React Flow) | - | Inherits from `--radius` system |

All other radius values use Tailwind classes (`rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-full`).

### Z-Index

| File | Value | Context |
|---|---|---|
| navigation-sidebar.tsx | `z-40` | Sidebar overlay (2x) |
| flyout-panel.tsx | `z-30` | Flyout panel (2x) |
| mobile-warning-dialog.tsx | `z-50` | Mobile dialog |
| hub/hub-hero.tsx | `-z-10` | Background layer |
| workflows/page.tsx | `z-20` | Workflow controls |

### Box Shadows

| File | Value |
|---|---|
| docs-site globals.css | `0 8px 24px rgba(0,0,0,0.3)` |
| docs-site globals.css | `0 0 0 2px rgba(6,177,113,0.15)` |
| generate-og.tsx | `0 4px 16px rgba(0,0,0,0.5)` (exempt) |

Components use Tailwind shadow classes (`shadow-sm`, `shadow-lg`) which is correct.

### Transitions

| File | Value |
|---|---|
| app/globals.css:256 | `150ms` (stroke transition) |
| docs-site globals.css | `0.2s ease` (multiple) |
| docs-site globals.css | `color 0.2s ease` |

## Exemptions

These files are intentionally exempt from token requirements:

1. **`keeperhub/api/og/generate-og.tsx`** -- Server-rendered OG images, not interactive UI
2. **`lib/monaco-theme.ts`** -- Editor syntax highlighting, uses Monaco's own theming API
3. **`docs-site/`** -- Separate documentation site with its own design system

## Recurring Patterns

1. **`#09fd67` green accent** appears 12+ times across hub components -- needs a token
2. **`#2a3342` dark surface** appears 5+ times -- needs a token
3. **`#1a2230` dark card bg** appears 3+ times -- needs a token
4. **`text-[10px]`/`text-[11px]`** badge sizes appear 8+ times -- needs typography token
5. **Duplicated color palette** in project-form-dialog and tag-form-dialog
6. **`top-[60px]`** header offset used in sidebar and flyout -- needs a layout token
