/** Synthetic fixture helper: obtain an explicit short-lived checkout quote before creating an order. */
export async function withQuote(gql, cart, input) {
  const result = await gql('query($input:CartInput!){calculateCheckout(input:$input){quoteHash quoteToken}}', { input: cart });
  const quote = result.calculateCheckout;
  return { ...input, expectedQuoteHash: quote.quoteHash, expectedQuoteToken: quote.quoteToken };
}
