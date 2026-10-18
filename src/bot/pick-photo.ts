/**
 * Telegram lists photo sizes small to large. Picks the largest one within `maxBytes`.
 * A size without `file_size` counts only when it is the smallest (it can't be checked).
 */
export function pickPhoto(
  sizes: { file_id: string; file_size?: number }[],
  maxBytes: number,
): { file_id: string } | null {
  let picked: { file_id: string } | null = null;
  sizes.forEach((s, i) => {
    const fits = s.file_size === undefined ? i === 0 : s.file_size <= maxBytes;
    if (fits) picked = { file_id: s.file_id };
  });
  return picked;
}
