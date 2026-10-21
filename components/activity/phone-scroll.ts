// On phones the activity page scrolls as a whole instead of only its feed,
// with the date headings stuck under the app header and the pager stuck to the
// bottom. These classes are shared by the admin feed and the member preview so
// the sticky offsets are written once.
//
// --activity-sticky-top is the app header's bottom edge. It uses the same
// --header-height fallback as the settings shell and the version banner (the
// token itself is not loaded by the app); the header's 1px border overlaps it.
// --activity-pager-pad is the stuck pager's bottom padding: 12px, or the home
// indicator's inset where that is larger.

/** The fixed page container, which scrolls on phones. */
export const PHONE_PAGE_SCROLLER =
  "max-sm:overflow-y-auto max-sm:[--activity-sticky-top:calc(var(--header-height,60px)+var(--app-banner-height,0px))] max-sm:[--activity-pager-pad:max(0.75rem,env(safe-area-inset-bottom))]";

/** Wrappers between the scroller and the feed: at least a screen tall, growing with the feed. */
export const PHONE_PAGE_FILL = "max-sm:flex-[1_0_auto]";

/**
 * A date heading that sticks under the app header while the page scrolls,
 * with a little room under the header. Each heading is the first child of its
 * group, so the padding has to beat the headings' own first:pt-0.
 */
export const PHONE_STICKY_HEADING =
  "max-sm:top-(--activity-sticky-top) max-sm:first:pt-2";

/**
 * The feed's list: a row focused from the keyboard scrolls clear of the stuck
 * heading above and the pager below instead of hiding behind them. Set on the
 * rows rather than as the page's scroll padding, which would also push the
 * pager's own buttons "into view" and scroll the page when they get focus.
 * 2.5rem covers a stuck heading (about 33px). Above its bottom padding the
 * pager is 45px on one row, or 69px when the count and the buttons wrap onto
 * two (very large totals: about 100k+ events at 360px, 1M+ at 375px), so 5rem
 * plus that padding covers it with any home indicator.
 */
export const PHONE_FEED_LIST =
  "max-sm:[&_button]:scroll-mt-[calc(var(--activity-sticky-top)+2.5rem)] max-sm:[&_button]:scroll-mb-[calc(5rem+var(--activity-pager-pad))]";

/** The feed's top, where a page change scrolls back to: just under the header. */
export const PHONE_FEED_TOP = "max-sm:scroll-mt-(--activity-sticky-top)";

/** The loading skeleton keeps the list's last height, so the page does not shrink mid-load. */
export const PHONE_HELD_HEIGHT = "max-sm:min-h-(--activity-held-height)";
