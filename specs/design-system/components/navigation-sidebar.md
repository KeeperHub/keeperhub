# Navigation Sidebar

## Metadata

| Field | Value |
|---|---|
| Name | NavigationSidebar |
| Category | Navigation |
| Status | Active |
| File | `keeperhub/components/navigation-sidebar.tsx` |

## Overview

Primary left-side navigation for the application. Contains org switcher, workflow list, project/tag filters, and a collapsible flyout panel.

**When to use**: Always present on authenticated pages. Renders as full sidebar on desktop, sheet overlay on mobile.

**When not to use**: Unauthenticated/landing pages, onboarding flows.

## Anatomy

1. **Org Switcher** -- top section, switches active organization
2. **Navigation Links** -- main nav items (Workflows, Analytics, Hub, Settings)
3. **Workflow List** -- scrollable list of user's workflows
4. **Project/Tag Filters** -- collapsible filter sections
5. **User Menu** -- bottom section with user avatar and settings
6. **Mobile Overlay** -- sheet variant for small screens

## Tokens Used

| Token | Usage |
|---|---|
| `--sidebar` | Background color |
| `--sidebar-foreground` | Text color |
| `--sidebar-primary` | Active item text |
| `--sidebar-accent` | Hover background |
| `--sidebar-border` | Divider borders |
| `--sidebar-ring` | Focus indicator |
| `z-40` | Overlay z-index (should use `--z-sidebar`) |
| `top-[60px]` | Header offset (should use `--header-height`) |

## Props/API

Rendered as part of the app layout. No external props -- reads state from:
- Organization context (active org)
- Router (active route for highlighting)
- Workflow list query

## States

| State | Appearance |
|---|---|
| Default | Full sidebar visible, nav links with muted text |
| Active link | `sidebar-primary` text color, `sidebar-accent` background |
| Hover | `sidebar-accent` background |
| Mobile | Hidden by default, slides in as sheet overlay |
| Collapsed | Strip-width (32px) showing only icons |

## Workflow Row

Each workflow in the picker is a 32px row (`py-1.5`, `text-sm`) in three
fixed columns, so the name gets the same room on every row:

| Column | Content |
|---|---|
| Icon (20px tile) | Trigger-type icon from `components/workflow-trigger-icons.ts`. Green (`keeperhub-green` on a 10% tint) only when the workflow is enabled and fires on its own; grey with a `foreground/15` outline when disabled, and always for Manual. Tooltip leads with the status in words: "Disabled · Schedule trigger · Every 5 minutes"; Manual says "Manual trigger · Runs when you click Run Workflow". |
| Name (flexible) | Truncated; the full name shows above it on hover. Dimmed when disabled. |
| Label (64px, right-aligned, `text-xs`) | Always "how or when it fires": cadence ("5 min", "Hourly", "Daily", "Weekdays", "Custom"), event name, or "10 blocks"; empty for Webhook, Transfer and Manual, whose icon says it all. `foreground/75`, muted like the name when the workflow is off. The one status word is "Deactivated", in `text-status-deactivated` with a tooltip saying KeeperHub turned it off. Status otherwise comes from the icon colour and the dimmed name (and the tooltip and screen-reader text). Truncated with a tooltip. A cadence is named only when its gaps are even (`*/7` minutes or `*/5` hours read "Custom"); the icon tooltip then spells the schedule out, naming the timezone (UTC when none is saved) wherever it names a minute, a time, a day or the raw cron. A legacy "Scheduled" trigger shows as a grey Schedule icon with no label, its tooltip saying it does not run. |

On the open workflow's row (`bg-muted`) dimmed text and grey icons step up
to `foreground/55`. Tooltips open after 400ms. Status and trigger detail are
read to screen readers from a hidden span; the visible label is
`aria-hidden`.

## Workflow Filters

Both flyout panels that list workflows have a filter button left of their
title: the Workflows panel and a project's panel. Each panel keeps its own
filter.

- **Workflows panel**: the filter narrows the workflows outside any project
  ("Other Workflows"). The project list above them is never filtered, and
  its counts stay the full counts. The button is disabled when there are no
  workflows outside a project. An empty result shows under the "Other
  Workflows" header.
- **Project panel**: the filter narrows that project's workflows. Opening
  another project drops it.

Closing a panel, any way at all, drops its filter.

The filter button opens a row pinned to the top of the list with two
dropdown filters and no search:

- **Status**: Enabled, Disabled, Manual. Disabled notes "Incl. N deactivated"
  in the deactivated amber when KeeperHub turned any of its workflows off.
- **Trigger**: every trigger type, each with the row's icon tile, always
  grey (green would read as a status). Pyth Price is listed only when a
  workflow in the panel's list uses it or it is picked.

Each menu is a list of checkboxes with counts (`foreground/70`; an entry
that would empty the list dims its name, not its zero); it stays open while
you pick, and ends with "Clear ... filter". Within a menu picks add up
(Event or Block), and every entry can be ticked at once; across the two they
narrow (Enabled and Event); each menu counts the workflows the other lets
through. The button reads "Status All" until something is picked, then the
first pick (with its icon) and "+N". A clear button after the two menus
clears both.

Only one menu is open at a time. Menus open on click, Enter or arrow keys,
and also on hover after 250ms; while one is open, resting on the other
button switches to it. One opened by hover leaves focus where it was, gives
it back there when it closes, and closes 300ms after the pointer leaves
button and menu; clicking its button or pressing the down arrow keeps it
open and moves into it. Both menus stay inside the panel (it is their
collision boundary).

While any filter is on, the row stays in view and the filter button shows a
dot; clicking it then clears the filters and hides the row in one go
(tooltip "Clear filters and hide"). In a project's panel, tag groups are held
open and their headers turn into plain text. An empty result names the filters and offers
"Show all workflows".

A filter clears when its panel closes or the organization changes. Creating
a workflow (New Workflow, a template, a hub action, a scan suggestion,
onboarding) drops the Workflows panel's picks so the new workflow is
listed; the row, if open, stays open and focus stays where it was.

Dimmed text and grey icons step up on hover as on the open row. On keyboard
focus, after the same 400ms, a row's icon tooltip opens only when it has
something the row cannot show: a cut-off name in full, or why and when it
was deactivated ("Turned off by KeeperHub on Oct 6, 2026. Contact support to
turn it back on."). Escape or moving the mouse closes it.

Escape inside a menu, or on a hover-opened one, closes only the menu. On a
menu button with its menu shut it hides an unused row, but never clears
picks (a habitual second Escape would otherwise throw them away); with
nothing open it closes the panel. An Escape that closes a dialog, menu or
select inside the panel closes only that.

## Phones

### The drawer

- Below 768px the sidebar is not drawn. A menu button
  (`components/mobile-nav.tsx`, `md:hidden`) left of the logo opens the same
  items in a drawer from the left: New Workflow, the nav items (filtered by
  role with `visibleNavItems`, as in the sidebar), Settings, then Join Discord
  and Documentation.
- The sidebar and the drawer share what a pick does (`followNavItem`) and New
  Workflow's look (`NEW_WORKFLOW_LOOK`).
- Rows, New Workflow and the close button are 44px targets. The drawer slides
  in over 300ms and out over 200ms (the values of `--duration-slower` and
  `--duration-slow`), and does not slide with reduced motion.
- Workflows opens `/workflows?latest=edited`: the workflow edited most
  recently (never the internal `__current__` one), as there is no room for the
  workflow list. `/workflows` without it opens the newest.
- Items that need an account, and Workflows without a session, ask a
  signed-out visitor to sign in. Nothing can be picked until the session has
  loaded or while New Workflow is creating.
- Focus: a pick that opens something elsewhere (a page, an overlay, the
  sign-in prompt) closes the drawer and leaves focus to it. One that opens
  nothing here (the page already shown, Workflows on the workflows index,
  Discord and Documentation in a new tab) returns focus to the menu button.
- A failed New Workflow says so before going home, in the sidebar and the
  drawer; an anonymous visitor who already has a workflow is told to sign in
  for more.
- The list scrolls on a short screen (a phone turned sideways) under a fixed
  close button, and the drawer closes when the screen widens past 768px.
  Getting started is not in the drawer: its card floats out of the sidebar.

### The organization switcher

- Below 375px (the `xs` breakpoint) the header has no room for it, so it is in
  the drawer instead, under an "Organization" label above New Workflow: full
  width, 44px, with the name.
- Below 1024px a switch, from the drawer or the header, is announced in one
  toast: "Switching to X...", then "Switched to X". From 1024px the name
  shows and a switch that works has no toast.
- At any width a failed switch says "Couldn't switch to X." with a Try again
  button, for 12s; after a Try again that works, focus goes to the switcher
  once it shows that organization (to the menu button below xs), if focus
  went with the toast and not elsewhere, and once the header has caught up
  (never to a switcher about to hide). One that fails again, or does not
  run, leaves focus alone. Every Try again is announced, at every width.
  Toast buttons are 36px targets in `touch-ui` (the phone header or any
  touch screen; a rule in `app/globals.css`). Try again does nothing if that
  organization has become active meanwhile.
- One switch at a time (`org-switch-runner.ts`): while one runs, from a
  switcher or a leave or delete, both switchers show a spinner, are marked
  busy (dimmed) and keep their list shut; they stay focusable, so focus
  returns to them after a pick. A switch waits for the new organization to
  show, through the refresh of the active organization the auth client starts
  itself (waiting briefly for it, so no second request). A refresh that did
  not show it (a timeout, rate limiting, or one that hangs) is asked for
  again, twice, a little later, each time with a request of its own; the wait
  ends after about 8s whatever happens. The server has switched either way,
  so the switch is made, and the page is never loaded afresh on its own:
  should it still show the old organization, it says "Switched organization,
  but couldn't update the page." (12s, with Reload) instead of "Switched to
  X" (after leaving or deleting: "Left X. Now in Y, but couldn't update the
  page."), and picking the organization it shows switches to it again rather
  than only closing the list, until the page shows another. A digest link
  then opens its settings only once the page shows its organization, and not
  after another switch has started; with none shown, the switcher opens no
  other meanwhile. After the active organization goes away, the list is
  loaded afresh before the switcher opens another, so it does not reopen the
  one that went. The settings page's switch to the organization in its URL,
  and the digest email's link, run the same way, once the active organization,
  the list and any running switch are done (a switch that takes the lock first
  is waited for). A link for an organization the user is not in says so
  ("You're not a member of that organization.", 12s; the settings page then
  goes to `/settings`); a list that failed to load says that instead
  ("Couldn't load your organizations.", once, with Try again, which says
  "Loading your organizations..." and says it again should the list fail
  again). The settings page waits for the list; the digest link is let go, and
  its Try again follows it again once the list loads, so a list loaded later
  some other way never switches on its own. The digest link opens its settings
  once its switch is made, after a Try again too, keeps its param until it is
  done with, and is let go after its switch has run. Creating an organization,
  which makes it the active one, runs under the lock. The next switch clears
  the last one's toast.
- At any width, picking the organization in use only closes the list (and
  the drawer): switching to it again would clear the workflow editor. The
  page being behind (above) is the exception.
- A failed switch changes nothing. A switch from a workflow opens the new
  organization's last-edited workflow (never `__current__` or a deleted one).
  Leaving or deleting one that is not active only says so ("Left X").
  Leaving or deleting the active organization, from Settings or the manage
  organizations dialog, opens another and says so ("Left X. Now in Y.");
  leaving from Settings lands on `/settings`. If opening another fails, it
  says so with Try again ("Left X, but couldn't open Y.") and the dialog
  goes home. With no organization active, the switcher opens the first one
  quietly, once each time none is active and not while another switch runs;
  never when the active organization could not be loaded (no answer, or a
  server error: the user may be in one), or the list could not; then both
  switchers offer "Load organization", named "Load organization, try
  again", and never "Create Organization". The server answering that there
  is no such organization (deleted, or the user removed from it) counts as
  none active.
  If that fails ("Couldn't open X.", with Try again), or opening another
  after leaving or deleting fails, or any switch fails while none is active
  (a digest link's, say, whose failure then stays, and no other organization
  is opened over it), both switchers (header and menu) offer
  that organization: "Open X" with a retry mark (the mark alone in a phone's
  header), named "Try again: open X" at every width, announced when used. A
  768-1023px window with a mouse shows the header switcher while it offers
  one. An organization becoming active any way clears that.
- From 640px it shows the people icon, name and arrows, 200px wide, giving way
  when the header needs the room (the workflow editor on a tablet): the name is
  cut short, and below the `org-name` container size (a button under about
  114px) the initials take the place of the icon and name. Below 640px it
  shows the initials and the arrows.
- Below 1024px its label leads with what it shows (the name, plus the initials
  when the name has more than one word), so voice control finds it by either;
  from 1024px it is "Switch organization".
- Its list is never taller than the screen below it below 1024px. In
  `phone-ui` its rows are 44px, a long name wraps (no hover for its tooltip),
  the current organization's settings gear is a 26px target, and other
  organizations' gears (shown only on hover) are not drawn.

### Where the phone header applies

- Two custom variants in `app/globals.css` name it: `phone-ui` (below 768px,
  and 768-1023px without a mouse, so touch tablets) and `mouse-tablet`
  (768-1023px with a mouse). Their width-only counterparts for code (md and
  lg) are in `hooks/use-mobile.ts`.
- In `phone-ui` the header's sides keep an 8px gap and the switcher is in the
  header (or the drawer, below 375px). From 1024px, and in `mouse-tablet`, the
  header sits beside the sidebar; `mouse-tablet` has no switcher in the header
  (but while it offers to try again) and the avatar menu's organization item
  instead.
- The logo is only as wide as its mark below 768px (with a 26px-wide tap
  area), and the side padding clears a notch on a phone turned sideways.
- The wallet keeps its copy and settings buttons at every width. Its address
  shows in full from 420px (the `wallet` breakpoint), as its last 4 characters
  on one line ("…0dE3") from 375px, and not at all below that; screen readers
  hear "Wallet" and the short address at every width.

### Known gaps

- The workflow editor's own buttons do not fit a phone held upright (they run
  off the screen).
- On a phone turned sideways below about 700px (740px while Run shows a longer
  label) they overlap the squeezed switcher; the avatar and the nav button stay
  reachable.

## Code Example

```tsx
// Used in layout.tsx -- no direct instantiation needed
<NavigationSidebar />
```

## Cross-references

- [Flyout Panel](./flyout-panel.md) -- nested inside sidebar
- [Organization Switcher](./org-switcher.md) -- in the header, and in the phone drawer below 375px
