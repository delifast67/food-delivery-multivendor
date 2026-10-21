export async function quoteInput(gql: (query: string, variables?: any) => Promise<any>, input: any) {
  const result = await gql("query($i:CartInput!){calculateCheckout(input:$i){quoteHash quoteToken}}", {
    i: { restaurantId: input.restaurantId, items: input.items, point: input.deliveryAddress?.point ?? input.point },
  });
  const body = result.data ?? result;
  const quote = body.calculateCheckout;
  return { ...input, expectedQuoteHash: quote.quoteHash, expectedQuoteToken: quote.quoteToken };
}
