import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import PaymentPanel, { paymentAttemptStorageKey, safeCheckoutUrl } from "./PaymentPanel";
import { delifastApi, type Order, type PaymentSession } from "@/lib/delifast/api";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "order-1",
  accessToken: "access-token",
  status: "PAYMENT_PENDING",
  paymentStatus: "PENDING",
  createdAt: "2026-01-01T00:00:00Z",
  restaurantId: "restaurant-1",
  checkout: {
    currency: "XOF", subtotal: 1200, deliveryFee: 300, serviceFee: 0,
    tax: 0, discount: 0, total: 1500, items: [],
  },
  ...overrides,
});
const session = (overrides: Partial<PaymentSession> = {}): PaymentSession => ({
  orderId: "order-1", phase: "READY", channel: "ORANGE_MONEY_BF", mode: "live",
  checkoutUrl: null, providerStatus: "pending", paymentStatus: "PENDING", ...overrides,
});

let paymentSession: MockInstance<typeof delifastApi.paymentSession>;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  paymentSession = vi.spyOn(delifastApi, "paymentSession").mockResolvedValue(null);
  vi.spyOn(delifastApi, "refreshPayment").mockResolvedValue(session());
  vi.spyOn(delifastApi, "startPayment").mockResolvedValue(session());
});
afterEach(cleanup);

async function ready(value: PaymentSession | null = null) {
  paymentSession.mockResolvedValue(null);
  render(<PaymentPanel order={order()} />);
  if (value) {
    cleanup();
    paymentSession.mockResolvedValue(value);
    render(<PaymentPanel order={order()} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    return;
  }
  await waitFor(() => expect(screen.getByRole("button", { name: "Démarrer le paiement" })).toBeEnabled());
}

describe("PaymentPanel payment contract", () => {
  it("uses the server checkout amount and never offers an amount input", async () => {
    await ready();
    expect(screen.getByText(/Montant serveur/)).toHaveTextContent("Montant serveur :");
    expect(screen.getByText(/1\s*500 XOF/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/montant/i)).not.toBeInTheDocument();
  });

  it("keeps payment unavailable disabled and does not start", async () => {
    paymentSession.mockRejectedValue(Object.assign(new Error("disabled"), { code: "PAYMENT_DISABLED" }));
    render(<PaymentPanel order={order()} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Paiement indisponible");
    expect(screen.queryByRole("button", { name: "Démarrer le paiement" })).not.toBeInTheDocument();
    expect(delifastApi.startPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "En attente de confirmation serveur"],
    ["authorized", "Autorisé, mais pas encore payé"],
    ["failed", "Paiement échoué"],
    ["canceled", "Paiement annulé"],
    ["expired", "Paiement expiré"],
  ])("does not claim paid for provider status %s", async (providerStatus, label) => {
    await ready(session({ providerStatus }));
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.queryByRole("button", { name: "Démarrer le paiement" })).not.toBeInTheDocument();
  });

  it.each(["UNKNOWN", "CREATING"])("does not claim paid for %s", async phase => {
    await ready(session({ phase }));
    expect(screen.getByRole("status")).toHaveTextContent("Tentative incertaine");
    expect(screen.queryByRole("button", { name: "Démarrer le paiement" })).not.toBeInTheDocument();
  });

  it("does not claim paid for sandbox completed, but confirms a live PAID session", async () => {
    await ready(session({ providerStatus: "completed", mode: "sandbox" }));
    expect(screen.getByRole("status")).toHaveTextContent("sandbox ou non réglé");
    expect(screen.queryByRole("button", { name: "Démarrer le paiement" })).not.toBeInTheDocument();

    cleanup();
    paymentSession.mockResolvedValue(session({ providerStatus: "completed", mode: "live", paymentStatus: "PAID" }));
    render(<PaymentPanel order={order()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Paiement confirmé par le serveur"));
    expect(screen.queryByRole("button", { name: "Démarrer le paiement" })).not.toBeInTheDocument();
  });

  it("accepts server PAID without a return URL", async () => {
    await ready(session({ paymentStatus: "PAID", mode: "live", checkoutUrl: null }));
    expect(screen.getByRole("status")).toHaveTextContent("Paiement confirmé par le serveur");
    expect(screen.queryByRole("link", { name: /Ouvrir la page/ })).not.toBeInTheDocument();
  });

  it("rejects HTTPS URLs containing userinfo", async () => {
    expect(safeCheckoutUrl("https://user:password@pay.example/checkout")).toBe(false);
    paymentSession.mockResolvedValue(session({ checkoutUrl: "https://user:password@pay.example/checkout" }));
    render(<PaymentPanel order={order()} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("URL de paiement refusée");
    expect(screen.queryByRole("link", { name: /Ouvrir la page/ })).not.toBeInTheDocument();
  });

  it("persists an attempt before starting and sends no client amount", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Démarrer le paiement" }));
    await waitFor(() => expect(delifastApi.startPayment).toHaveBeenCalledTimes(1));
    const input = vi.mocked(delifastApi.startPayment).mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({ orderId: "order-1", accessToken: "access-token", channel: "ORANGE_MONEY_BF" }));
    expect(input).not.toHaveProperty("amount");
    expect(JSON.parse(localStorage.getItem(paymentAttemptStorageKey)!)).toEqual(expect.objectContaining({ orderId: "order-1" }));
  });

  it("does not start when durable payment storage fails", async () => {
    await ready();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "Démarrer le paiement" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("quota");
    expect(delifastApi.startPayment).not.toHaveBeenCalled();
  });

  it("coalesces synchronous double click into one start", async () => {
    await ready();
    const deferred = new Promise<PaymentSession>(() => undefined);
    vi.mocked(delifastApi.startPayment).mockReturnValue(deferred);
    const button = screen.getByRole("button", { name: "Démarrer le paiement" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(delifastApi.startPayment).toHaveBeenCalledTimes(1));
  });

  it("reconciles a lost start response and remounts without creating a new payment", async () => {
    await ready();
    const key = { orderId: "order-1", idempotencyKey: "stable-payment-key", channel: "ORANGE_MONEY_BF" };
    localStorage.setItem(paymentAttemptStorageKey, JSON.stringify(key));
    vi.mocked(delifastApi.startPayment).mockRejectedValueOnce(new Error("lost response"));
    fireEvent.click(screen.getByRole("button", { name: "Démarrer le paiement" }));
    await screen.findByRole("alert");
    expect(delifastApi.startPayment).toHaveBeenCalledTimes(1);
    cleanup();
    paymentSession.mockResolvedValue(session({ phase: "READY", providerStatus: "authorized" }));
    render(<PaymentPanel order={order()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Autorisé"));
    expect(delifastApi.startPayment).toHaveBeenCalledTimes(1);
  });

  it("resets stale session state when order changes", async () => {
    const view = render(<PaymentPanel order={order()} />);
    await waitFor(() => expect(paymentSession).toHaveBeenCalledWith("order-1", "access-token"));
    paymentSession.mockResolvedValue(session({ orderId: "order-2", providerStatus: "authorized" }));
    view.rerender(<PaymentPanel order={order({ id: "order-2", accessToken: "token-2" })} />);
    await waitFor(() => expect(paymentSession).toHaveBeenCalledWith("order-2", "token-2"));
    expect(screen.getByRole("status")).toHaveTextContent("Autorisé");
  });
});

it("reuses the persisted key after a lost response when the server still has no session", async () => {
  await ready();
  vi.mocked(delifastApi.startPayment).mockRejectedValueOnce(new Error("response lost"));
  fireEvent.click(screen.getByRole("button", { name: "Démarrer le paiement" }));
  await screen.findByRole("alert");
  const original = vi.mocked(delifastApi.startPayment).mock.calls[0][0];
  cleanup();
  render(<PaymentPanel order={order()} />);
  await screen.findByRole("button", { name: "Démarrer le paiement" });
  fireEvent.click(screen.getByRole("button", { name: "Démarrer le paiement" }));
  await waitFor(() => expect(delifastApi.startPayment).toHaveBeenCalledTimes(2));
  expect(vi.mocked(delifastApi.startPayment).mock.calls[1][0]).toEqual(original);
});

it("ignores a late paid response belonging to an old order", async () => {
  let resolveOld!: (value: PaymentSession) => void;
  paymentSession.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<PaymentPanel order={order()} />);
  paymentSession.mockResolvedValue(session({ orderId: "order-2", providerStatus: "authorized" }));
  view.rerender(<PaymentPanel order={order({ id: "order-2" })} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Autorisé"));
  resolveOld(session({ paymentStatus: "PAID" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Autorisé"));
  expect(screen.getByRole("status")).not.toHaveTextContent("Paiement confirmé par le serveur");
});
