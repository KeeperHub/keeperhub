/** Formats a USD-cents amount as a short dollar label, e.g. "$1" or "$1.50". */
export function formatGasCreditUsd(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars % 1 === 0 ? dollars.toString() : dollars.toFixed(2)}`;
}
