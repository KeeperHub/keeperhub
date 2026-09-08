# Landing Page Auth Integration Plan

## Overview

Add URL-based auth triggering so the landing page can direct users to specific auth modals:
- "Open App" button → Sign in modal
- "Get started free" button (new) → Create account modal

## Current State

### Landing Page (keeperhub-landing)
- "Open App" button links to `https://app.keeperhub.com` (opens in new tab)
- No "Get started free" button exists
- Button locations:
  - `src/components/header.tsx:44-50` (desktop)
  - `src/components/mobileNavigationLinks.tsx:20-26` (mobile menu)
  - `src/components/hero.tsx:25-32` (mobile hero CTA)

### Main App (keeperhub)
- Auth dialog (`components/auth/dialog.tsx`) is client-side, opens via `DialogTrigger`
- No URL-based triggering of auth modals exists
- Auth dialog views: `signin`, `signup`, `request-access`, `request-success`

## Implementation Plan

### Part 1: Main App (keeperhub) - URL Auth Handler

**Approach:** Fully self-contained in `/keeperhub` directory (no changes to core files)

#### Files to Create

**`/keeperhub/components/auth/url-auth-handler.tsx`**
- Reads URL search params (`?auth=signin` or `?auth=signup`)
- Renders auth dialog that auto-opens based on the param
- Sets initial view based on param value
- Cleans up URL param after dialog is opened (optional)

#### Files to Modify

**`/keeperhub/components/extension-loader.tsx`**
```tsx
"use client";

import "@/keeperhub/lib/extensions";
import { UrlAuthHandler } from "@/keeperhub/components/auth/url-auth-handler";

export function KeeperHubExtensionLoader() {
  return <UrlAuthHandler />;
}
```

#### URL Auth Handler Component Structure

```tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
// Reuse existing auth dialog components/logic or create standalone dialog

type AuthView = "signin" | "signup";

export function UrlAuthHandler() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AuthView>("signin");

  useEffect(() => {
    const authParam = searchParams.get("auth");
    if (authParam === "signin" || authParam === "signup") {
      setView(authParam);
      setOpen(true);
      // Optionally clean up URL
      // router.replace(window.location.pathname, { scroll: false });
    }
  }, [searchParams]);

  if (!open) return null;

  // Render dialog with appropriate view
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Auth form content based on view */}
    </Dialog>
  );
}
```

### Part 2: Landing Page (keeperhub-landing)

#### Files to Modify

**`src/components/header.tsx`**
- Change "Open App" URL: `https://app.keeperhub.com` → `https://app.keeperhub.com?auth=signin`
- Add "Get started free" button with URL: `https://app.keeperhub.com?auth=signup`

**`src/components/mobileNavigationLinks.tsx`**
- Change "Open App" URL to include `?auth=signin`
- Add "Get started free" button

**`src/components/hero.tsx`**
- Change mobile "Open App" URL to include `?auth=signin`
- Add "Get started free" button for desktop/mobile

#### Button Styling

Existing styles from `globals.css`:
```css
.primary-button {
  @apply bg-primary-green text-slate-900 rounded-full px-4 py-2 font-medium text-lg;
}
```

For "Get started free", consider a secondary/outline style or keep same primary style.

## URL Scheme

| Button | URL |
|--------|-----|
| Open App | `https://app.keeperhub.com?auth=signin` |
| Get started free | `https://app.keeperhub.com?auth=signup` |

## Testing Checklist

- [ ] `?auth=signin` opens Sign in modal
- [ ] `?auth=signup` opens Create account modal
- [ ] Modal closes properly and URL is cleaned (if implemented)
- [ ] Direct navigation without params works normally
- [ ] Mobile navigation works correctly
- [ ] Desktop navigation works correctly

## Notes

- All main app changes contained in `/keeperhub` directory per project policy
- No modifications to core `components/auth/dialog.tsx`
- Landing page changes are straightforward URL updates + new button
