export interface PaymentProvider {
  readonly name: string;
  /** The provider boundary is deliberately local; production adapters must be added separately. */
  confirmPayment(orderId: string): Promise<{ paymentStatus: "PAID" }>;
}

export class DemoPaymentProvider implements PaymentProvider {
  readonly name = "demo";
  async confirmPayment(_orderId: string): Promise<{ paymentStatus: "PAID" }> {
    return { paymentStatus: "PAID" };
  }
}

export function getPaymentProvider(): PaymentProvider | undefined {
  return process.env.DELIFAST_DEMO_PAYMENTS === "true"
    ? new DemoPaymentProvider()
    : undefined;
}
