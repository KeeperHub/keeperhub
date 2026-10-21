import * as React from "react"

// Tailwind's sm, md and lg (--breakpoint-sm and so on in its default theme;
// a unit test pins them), for code that must agree with the CSS: below sm
// the analytics Projects drawer takes the runs card's place; below md the
// sidebar gives way to the nav drawer; below lg the header switcher can
// show initials.
export const BELOW_SM_QUERY = "(width < 40rem)"
export const BELOW_MD_QUERY = "(width < 48rem)"
export const BELOW_LG_QUERY = "(width < 64rem)"

// One MediaQueryList per query, shared by every reader and by the
// subscription, so no render builds one. Kept per matchMedia, so one put in
// its place (a test's) starts afresh.
const mediaQueryLists = new WeakMap<
  typeof window.matchMedia,
  Map<string, MediaQueryList>
>()

function mediaQueryList(query: string): MediaQueryList {
  let lists = mediaQueryLists.get(window.matchMedia)
  if (!lists) {
    lists = new Map()
    mediaQueryLists.set(window.matchMedia, lists)
  }
  let list = lists.get(query)
  if (!list) {
    list = window.matchMedia(query)
    lists.set(query, list)
  }
  return list
}

/**
 * Whether a media query matches, kept up to date. Right from the first render
 * on the client; false on the server and while hydrating, then corrected.
 */
export function useMediaQuery(query: string): boolean {
  // Stable per query, so a re-render does not subscribe again.
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query]
  )
  const getSnapshot = React.useCallback(
    () => mediaQueryList(query).matches,
    [query]
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

function getServerSnapshot(): boolean {
  return false
}

export function useIsMobile(): boolean {
  return useMediaQuery(BELOW_MD_QUERY)
}
