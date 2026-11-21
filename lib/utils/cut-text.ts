const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;

// The first `length` UTF-16 units, one fewer when that would end on the
// first half of a surrogate pair (an emoji, for one).
export function cutText(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  return last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX
    ? text.slice(0, length - 1)
    : text.slice(0, length);
}
