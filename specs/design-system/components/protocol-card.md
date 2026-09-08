# Protocol Card

## Metadata

| Field | Value |
|---|---|
| Name | ProtocolCard |
| Category | Hub |
| Status | Active |
| File | `keeperhub/components/hub/protocol-card.tsx` |

## Overview

Displays a blockchain protocol integration in the Hub. Shows protocol name, icon, supported chains, and available actions count.

**When to use**: Inside ProtocolGrid on the Hub page.

**When not to use**: Not for workflow nodes or action grid items.

## Anatomy

1. **Icon Container** -- protocol logo in a dark rounded container
2. **Protocol Name** -- bold text label
3. **Chain Badges** -- small green badges showing supported networks
4. **Action Count** -- number of available actions
5. **Card Container** -- bordered dark surface with hover effect

## Tokens Used

| Token | Should Use | Currently Uses |
|---|---|---|
| `--color-hub-card` | Card background | `bg-[#1a2230]` (hardcoded) |
| `--color-hub-icon-bg` | Icon container | `bg-[#2a3342]` (hardcoded) |
| `--color-text-accent` | Chain badge text | `text-[#09fd67]` (hardcoded) |
| `--color-bg-accent` | Chain badge bg | `bg-[#09fd671a]` (hardcoded) |
| `--border` | Card border | `border-border/50` (correct) |
| `text-[10px]` | Badge font size | Should use `--ds-text-2xs` |

## Props/API

```typescript
interface ProtocolCardProps {
  protocol: Protocol;
  onClick: (protocol: Protocol) => void;
}
```

## States

| State | Appearance |
|---|---|
| Default | Dark card with protocol info, subtle border |
| Hover | Border brightens, slight scale or brightness change |
| Active/Selected | Opens ProtocolDetailModal |

## Code Example

```tsx
<ProtocolCard
  protocol={aaveV3}
  onClick={(p) => openDetail(p)}
/>
```

## Cross-references

- [Protocol Detail](./protocol-detail.md) -- opened on click
- [Protocol Strip](./protocol-strip.md) -- alternative compact layout
