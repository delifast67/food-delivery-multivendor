export interface DemoPaymentContract {
  readonly name: string;
  /** The provider boundary is deliberately local; production adapters must be added separately. */
  confirmPayment(orderId: string): Promise<{ paymentStatus: "PAID" }>;
}

export class DemoPaymentProvider implements DemoPaymentContract {
  readonly name = "demo";
  async confirmPayment(_orderId: string): Promise<{ paymentStatus: "PAID" }> {
    return { paymentStatus: "PAID" };
  }
}

export function getPaymentProvider(): DemoPaymentContract | undefined {
  return process.env.DELIFAST_DEMO_PAYMENTS === "true" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.PAYMENT_PROVIDER &&
    process.env.PAYDUNYA_ENABLED !== "true"
    ? new DemoPaymentProvider()
    : undefined;
}
