/**
 * Money is integer nano-USD (billionths of a dollar) everywhere it is
 * summed, compared, stored or reconciled. Floats are not a money type: add
 * enough of them and the total stops matching the platform's, which is
 * exactly the disagreement a rebilling platform exists to avoid.
 *
 * The platform hands out both spellings. `*_nano_usd` is the canonical
 * integer and is what this app carries; `*_usd` is a decimal display string
 * for rendering. Read the integer, sum the integer, and convert once, here,
 * at the boundary where a figure becomes something a person looks at.
 *
 * Everything below is that boundary. Nothing else in the app divides by a
 * billion.
 */
export const NANO_PER_USD = 1_000_000_000;

/** Display only. Never sum the result: sum the nano-USD integers instead. */
export function nanoToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}

/**
 * Display only, null-preserving. Spend the platform could not total arrives
 * as null, and it has to stay null: rendering it as $0.00 would be a figure
 * the reader takes for real money.
 */
export function nanoToUsdOrNull(nano: number | null): number | null {
  return nano === null ? null : nanoToUsd(nano);
}
