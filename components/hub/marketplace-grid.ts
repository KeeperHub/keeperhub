// Column tracks shared by the leaderboard's header row and its rows. A
// hidden cell takes no track, so each width lists only the columns it
// shows: a spare track would pull the cells after it out of their columns
// and squeeze Name to nothing.
//
// The widths are the table's own (it is an @container), not the window's:
// the nav and the sort sidebar take a varying share beside it, so at a 1024px
// window the table can be about as narrow as on a phone. Under 36rem it shows
// rank, name and price (with the call count under it); owner, calls and
// chain join from 36rem, tags from 44rem, where the grid is the one it
// always had.
//
// Kept out of the "use client" row module: the header is rendered by a
// Server Component, which would receive a client reference instead of the
// string.
export const MARKETPLACE_GRID_COLUMNS =
  "grid-cols-[2rem_minmax(0,1fr)_5.5rem] @[36rem]:grid-cols-[48px_1fr_100px_72px_88px_64px] @[44rem]:grid-cols-[48px_1fr_140px_100px_72px_88px_64px]";
