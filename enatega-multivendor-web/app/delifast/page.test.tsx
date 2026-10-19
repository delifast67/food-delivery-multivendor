import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DelifastPage from "./page";
import { delifastApi, type Order } from "@/lib/delifast/api";

const restaurants = [
  {
    id: "r1",
    name: "Chez A",
    description: "A",
    menu: [
      {
        id: "m1",
        name: "Riz",
        description: "",
        priceXof: 1000,
        available: true,
      },
    ],
  },
  {
    id: "r2",
    name: "Chez B",
    description: "B",
    menu: [
      {
        id: "m2",
        name: "Poulet",
        description: "",
        priceXof: 2000,
        available: true,
      },
    ],
  },
];
const checkout = {
  currency: "XOF",
  subtotal: 1000,
  deliveryFee: 0,
  serviceFee: 0,
  tax: 0,
  discount: 0,
  total: 1000,
  items: [],
};
const order = {
  id: "o1",
  accessToken: "token",
  status: "PAYMENT_PENDING",
  paymentStatus: "PENDING",
  createdAt: "now",
  restaurantId: "r1",
  checkout,
} as Order;

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(delifastApi, "restaurants").mockResolvedValue(restaurants);
  vi.spyOn(delifastApi, "checkout").mockResolvedValue(checkout);
  vi.spyOn(delifastApi, "order").mockResolvedValue(null);
});

describe("Delifast UI state", () => {
  it("allows selecting another restaurant after clearing the mono-restaurant cart", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez A");
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Riz" }));
    fireEvent.click(screen.getByRole("button", { name: "Vider le panier" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Poulet" }));
    expect(screen.getAllByText("Poulet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Riz")).toBeInTheDocument(); // menu remains visible; cart has only Poulet
    expect(screen.getByText("1 article")).toBeInTheDocument();
  });

  it("ignores a synchronous double click while the order request is pending", async () => {
    let resolveOrder: (value: Order) => void = () => undefined;
    const place = vi.spyOn(delifastApi, "placeOrder").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOrder = resolve as (value: Order) => void;
        }),
    );
    render(<DelifastPage />);
    await screen.findByText("Chez A");
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Riz" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enregistrer la commande" }),
      ).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText("Nom du destinataire"), {
      target: { value: "A" },
    });
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.change(screen.getByLabelText("Quartier"), {
      target: { value: "Koulouba" },
    });
    fireEvent.change(screen.getByLabelText("Repère"), {
      target: { value: "Mairie" },
    });
    const button = screen.getByRole("button", {
      name: "Enregistrer la commande",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(place).toHaveBeenCalledTimes(1);
    resolveOrder(order);
    await screen.findByText("COMMANDE ENREGISTRÉE");
  });
});

async function prepareOrder() {
  await screen.findByText("Chez A");
  fireEvent.click(screen.getByRole("button", { name: "Ajouter Riz" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    ).not.toBeDisabled(),
  );
  fireEvent.change(screen.getByLabelText("Nom du destinataire"), {
    target: { value: "Client Démo" },
  });
  fireEvent.change(screen.getByLabelText("Téléphone"), {
    target: { value: "+22670123456" },
  });
  fireEvent.change(screen.getByLabelText("Quartier"), {
    target: { value: "Koulouba" },
  });
  fireEvent.change(screen.getByLabelText("Repère"), {
    target: { value: "Repère fictif" },
  });
}

describe("Delifast recovery", () => {
  it("replays the exact saved payload after a lost response and reload, then clears it for a new order", async () => {
    const { DelifastApiError, attemptStorageKey } =
      await import("@/lib/delifast/api");
    const place = vi
      .spyOn(delifastApi, "placeOrder")
      .mockRejectedValueOnce(
        new DelifastApiError("Réponse perdue", "unavailable"),
      )
      .mockResolvedValue(order);
    const first = render(<DelifastPage />);
    await prepareOrder();
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByRole("button", { name: "Reprendre la même tentative" });
    expect(screen.getByLabelText("Nom du destinataire")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Ajouter Poulet" }),
    ).toBeDisabled();
    const original = place.mock.calls[0][0];
    expect(
      JSON.parse(localStorage.getItem(attemptStorageKey)!).idempotencyKey,
    ).toBe(original.idempotencyKey);
    first.unmount();
    render(<DelifastPage />);
    const retry = await screen.findByRole("button", {
      name: "Reprendre la même tentative",
    });
    fireEvent.click(retry);
    await screen.findByText("COMMANDE ENREGISTRÉE");
    expect(place).toHaveBeenCalledTimes(2);
    expect(place.mock.calls[1][0]).toEqual(original);
    fireEvent.click(
      screen.getByRole("button", { name: "Retour aux restaurants" }),
    );
    expect(localStorage.getItem(attemptStorageKey)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Ajouter Poulet" }),
    ).not.toBeDisabled();
    expect(screen.queryByText("1 article")).not.toBeInTheDocument();
  });

  it("keeps a known order locked if its lookup fails and allows only idempotent replay", async () => {
    const { attemptStorageKey } = await import("@/lib/delifast/api");
    const payload = {
      restaurantId: "r1",
      items: [{ menuItemId: "m1", quantity: 1 }],
      deliveryAddress: {
        recipientName: "Client",
        phone: "+22670123456",
        city: "Ouagadougou",
        neighborhood: "Koulouba",
        landmark: "Fictif",
        instructions: "",
      },
    };
    localStorage.setItem(
      attemptStorageKey,
      JSON.stringify({
        idempotencyKey: "known-order-key",
        payload,
        order: { id: order.id, accessToken: order.accessToken },
      }),
    );
    vi.mocked(delifastApi.order).mockRejectedValue(new Error("offline"));
    const place = vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(order);
    render(<DelifastPage />);
    await screen.findByText("Chez A");
    expect(
      screen.getByRole("button", { name: "Ajouter Poulet" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la même tentative" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    expect(place).toHaveBeenCalledWith({
      ...payload,
      idempotencyKey: "known-order-key",
    });
  });

  it("never sends a request when saving the durable key fails", async () => {
    const place = vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(order);
    render(<DelifastPage />);
    await prepareOrder();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByText(/aucun envoi n'a été effectué/);
    expect(place).not.toHaveBeenCalled();
  });

  it("removes a stale total when a new checkout fails", async () => {
    render(<DelifastPage />);
    await prepareOrder();
    vi.mocked(delifastApi.checkout).mockRejectedValue(
      new Error("Plat indisponible"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Augmenter Riz" }));
    await screen.findByText("Plat indisponible");
    expect(screen.queryByText("Total serveur")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    ).toBeDisabled();
  });

  it("releases the restaurant when the last item is removed", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez A");
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Riz" }));
    fireEvent.click(screen.getByRole("button", { name: "Diminuer Riz" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Poulet" }));
    expect(
      screen.getByRole("button", { name: "Augmenter Poulet" }),
    ).toBeInTheDocument();
  });
});
