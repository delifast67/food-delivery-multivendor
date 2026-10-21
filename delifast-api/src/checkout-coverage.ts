/** Inventaire exhaustif des mutations qui influencent l'admission checkout.
 * Un nouveau chemin doit être ajouté ici et testé sur replica set avant opt-in.
 * Ce manifeste n'autorise ni production ni déploiement et ne remplace pas les guards.
 */
export const REQUIRED_CHECKOUT_WRITERS = [
  "menu-price", "menu-availability", "menu-options", "menu-archive",
  "restaurant-open", "restaurant-hours", "restaurant-zone-references",
  "delivery-zone-update", "delivery-zone-create",
] as const;
export type CheckoutWriterPath = typeof REQUIRED_CHECKOUT_WRITERS[number];
export const CHECKOUT_WRITER_COVERAGE: Readonly<Record<CheckoutWriterPath, boolean>> = Object.freeze({
  "menu-price": true,
  "menu-availability": true,
  "menu-options": true,
  "menu-archive": true,
  "restaurant-open": true,
  "restaurant-hours": true,
  "restaurant-zone-references": true,
  "delivery-zone-update": true,
  "delivery-zone-create": true,
});
export function hasCompleteCheckoutWriterCoverage(
  coverage: Readonly<Partial<Record<CheckoutWriterPath, boolean>>> = CHECKOUT_WRITER_COVERAGE,
): boolean {
  return REQUIRED_CHECKOUT_WRITERS.every(path => coverage[path] === true);
}
export function assertCompleteCheckoutWriterCoverage(coverage: Readonly<Partial<Record<CheckoutWriterPath, boolean>>> = CHECKOUT_WRITER_COVERAGE) {
  if (!hasCompleteCheckoutWriterCoverage(coverage)) throw new Error("CHECKOUT_WRITER_COVERAGE_INCOMPLETE");
}
