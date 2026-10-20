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
      await screen.findByRole("button", { name: "Ajouter Poulet" }),
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

describe("Delifast suivi opérationnel", () => {
  function rememberOrder() {
    localStorage.setItem(
      "delifast-order-attempt",
      JSON.stringify({
        idempotencyKey: "tracking-known-order",
        payload: {
          restaurantId: "r1",
          items: [{ menuItemId: "m1", quantity: 1 }],
          deliveryAddress: {
            recipientName: "Démo",
            phone: "+22670000000",
            city: "Ouagadougou",
            neighborhood: "Fictif",
            landmark: "Ne pas livrer",
            instructions: "",
          },
        },
        order: { id: order.id, accessToken: order.accessToken },
      }),
    );
  }
  it("actualise le titre et l’historique lorsque le livreur termine sa mission", async () => {
    rememberOrder();
    vi.mocked(delifastApi.order)
      .mockResolvedValueOnce(order)
      .mockResolvedValue({
        ...order,
        status: "DELIVERED",
        paymentStatus: "PAID",
        history: [
          {
            status: "DELIVERED",
            at: "2026-01-01T12:00:00Z",
            actorRole: "RIDER",
          },
        ],
      });
    render(<DelifastPage />);
    await screen.findByRole("heading", {
      name: "Votre commande est en attente de paiement.",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actualiser le suivi" }),
    );
    await screen.findByRole("heading", {
      name: "Votre commande a été livrée (démo).",
    });
    expect(
      screen.getByLabelText("Historique de la commande"),
    ).toHaveTextContent("Livrée");
    expect(delifastApi.order).toHaveBeenLastCalledWith(
      order.id,
      order.accessToken,
    );
    expect(
      screen.queryByRole("heading", {
        name: "Votre commande est en attente de paiement.",
      }),
    ).not.toBeInTheDocument();
  });
  it("garde le dernier statut connu et affiche l’échec réseau sans perdre le jeton", async () => {
    rememberOrder();
    vi.mocked(delifastApi.order)
      .mockResolvedValueOnce(order)
      .mockRejectedValueOnce(new Error("Réseau interrompu"));
    render(<DelifastPage />);
    await screen.findByRole("heading", {
      name: "Votre commande est en attente de paiement.",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actualiser le suivi" }),
    );
    await screen.findByText("Actualisation impossible : Réseau interrompu");
    expect(
      screen.getByRole("heading", {
        name: "Votre commande est en attente de paiement.",
      }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("delifast-order-attempt")!).order
        .accessToken,
    ).toBe(order.accessToken);
  });
});

describe("Delifast options and menu grouping", () => {
  const richRestaurants = [
    {
      id: "rx",
      name: "Chez Options",
      description: "",
      open: true,
      categories: [
        {
          id: "active",
          name: "Plats",
          sortOrder: 1,
          archived: false,
          version: 1,
        },
      ],
      menu: [
        {
          id: "mx",
          name: "Bowl",
          description: "",
          priceXof: 2000,
          available: true,
          categoryId: "missing",
          optionGroups: [
            {
              id: "g",
              name: "Taille",
              minSelections: 1,
              maxSelections: 1,
              options: [
                { id: "small", name: "Petit", priceXof: 0, available: true },
                { id: "large", name: "Grand", priceXof: 500, available: true },
                {
                  id: "sold",
                  name: "Indisponible",
                  priceXof: 100,
                  available: false,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  beforeEach(() => {
    vi.mocked(delifastApi.restaurants).mockResolvedValue(richRestaurants);
  });
  it("bloque l'ajout tant qu'un groupe requis n'est pas choisi", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    fireEvent.click(screen.getByRole("button", { name: "Configurer Bowl" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter au panier" }));
    expect(screen.getByRole("alert")).toHaveTextContent("options requises");
    expect(
      screen.getByText("Votre panier").parentElement,
    ).not.toHaveTextContent("Bowl");
  });
  it("envoie les sélections dans le payload serveur", async () => {
    const place = vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(order);
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    fireEvent.click(screen.getByRole("button", { name: "Configurer Bowl" }));
    fireEvent.click(screen.getByLabelText(/Grand/));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter au panier" }));
    await waitFor(() => expect(screen.getByText(/Grand/)).toBeInTheDocument());
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
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enregistrer la commande" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await waitFor(() => expect(place).toHaveBeenCalled());
    expect(place.mock.calls[0][0].items[0].selections).toEqual([
      { groupId: "g", optionIds: ["large"] },
    ]);
  });
  it("garde deux configurations distinctes et ajuste chaque clé", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    for (const option of [/Petit/, /Grand/]) {
      fireEvent.click(screen.getByRole("button", { name: "Configurer Bowl" }));
      fireEvent.click(screen.getByLabelText(option));
      fireEvent.click(
        screen.getByRole("button", { name: "Ajouter au panier" }),
      );
    }
    expect(screen.getAllByText("Bowl").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Petit/)).toBeInTheDocument();
    expect(screen.getByText(/Grand/)).toBeInTheDocument();
  });
  it("désactive une option indisponible", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    fireEvent.click(screen.getByRole("button", { name: "Configurer Bowl" }));
    expect(screen.getByLabelText(/Indisponible/)).toBeDisabled();
  });
  it("affiche le fallback sans catégorie pour une catégorie inconnue", async () => {
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    expect(
      screen.getByRole("heading", { name: "Sans catégorie" }),
    ).toBeInTheDocument();
  });
  it("permet de désélectionner un choix facultatif limité à un", async () => {
    const optional = structuredClone(richRestaurants);
    optional[0].menu[0].optionGroups[0].minSelections = 0;
    vi.mocked(delifastApi.restaurants).mockResolvedValue(optional);
    render(<DelifastPage />);
    await screen.findByText("Chez Options");
    fireEvent.click(screen.getByRole("button", { name: "Configurer Bowl" }));
    const option = screen.getByRole("checkbox", { name: /Grand/ });
    fireEvent.click(option);
    expect(option).toBeChecked();
    fireEvent.click(option);
    expect(option).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter au panier" }));
    await waitFor(() =>
      expect(delifastApi.checkout).toHaveBeenCalledWith({
        restaurantId: "rx",
        items: [{ menuItemId: "mx", quantity: 1 }],
        point: { latitude: 12.3714, longitude: -1.5197 },
      }),
    );
  });
});

describe("Zones de livraison côté client", () => {
  it("transmet le point à la découverte et au devis, puis invalide le devis hors zone", async () => {
    const { DelifastApiError } = await import("@/lib/delifast/api");
    render(<DelifastPage />);
    await screen.findByText("Chez A");
    expect(delifastApi.restaurants).toHaveBeenCalledWith({
      latitude: 12.3714,
      longitude: -1.5197,
    });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Riz" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enregistrer la commande" }),
      ).not.toBeDisabled(),
    );
    expect(delifastApi.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        point: { latitude: 12.3714, longitude: -1.5197 },
      }),
    );
    vi.mocked(delifastApi.restaurants).mockResolvedValue([]);
    vi.mocked(delifastApi.checkout).mockRejectedValue(
      new DelifastApiError(
        "Point hors zone de livraison",
        "validation",
        400,
        "OUT_OF_DELIVERY_ZONE",
      ),
    );
    fireEvent.change(screen.getByLabelText("Latitude"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(delifastApi.restaurants).toHaveBeenLastCalledWith({
        latitude: 0,
        longitude: -1.5197,
      }),
    );
    await screen.findByText("Point hors zone de livraison");
    expect(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    ).toBeDisabled();
  });
  it("inclut le point du devis dans la nouvelle adresse sans modifier un prix côté client", async () => {
    const place = vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(order);
    render(<DelifastPage />);
    await prepareOrder();
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    const payload = place.mock.calls[0][0];
    expect(payload.deliveryAddress.point).toEqual({
      latitude: 12.3714,
      longitude: -1.5197,
    });
    expect(payload).not.toHaveProperty("deliveryFee");
    expect(payload).not.toHaveProperty("point");
  });
});

describe("Confirmation sans avertissement périmé", () => {
  it("retire l'avertissement mono-restaurant seulement après la réponse serveur", async () => {
    vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(order);
    render(<DelifastPage />);
    await prepareOrder();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Poulet" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Votre panier est mono-restaurant",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    expect(
      screen.queryByText(/Votre panier est mono-restaurant/),
    ).not.toBeInTheDocument();
  });

  it("ne transforme pas une réponse perdue en confirmation et nettoie la notice après reprise réussie", async () => {
    const { DelifastApiError } = await import("@/lib/delifast/api");
    const place = vi
      .spyOn(delifastApi, "placeOrder")
      .mockRejectedValueOnce(
        new DelifastApiError("Réponse perdue", "unavailable"),
      )
      .mockResolvedValueOnce(order);
    render(<DelifastPage />);
    await prepareOrder();
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByText(/Réponse incertaine/);
    expect(screen.queryByText("COMMANDE ENREGISTRÉE")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la même tentative" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    expect(screen.queryByText(/Réponse incertaine/)).not.toBeInTheDocument();
    expect(place.mock.calls[1][0]).toEqual(place.mock.calls[0][0]);
  });

  it("sépare les options nommées du plat et de la ligne de total serveur", async () => {
    const snapshotOrder = {
      ...order,
      checkout: {
        ...checkout,
        items: [
          {
            menuItemId: "m1",
            name: "Riz",
            quantity: 1,
            baseUnitPrice: 1000,
            unitPrice: 1000,
            total: 1000,
            selectedOptions: [
              {
                groupId: "g",
                groupName: "Format",
                optionId: "o",
                name: "Grand",
                priceXof: 0,
              },
            ],
          },
        ],
      },
    } as Order;
    vi.spyOn(delifastApi, "placeOrder").mockResolvedValue(snapshotOrder);
    render(<DelifastPage />);
    await prepareOrder();
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la commande" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    const snapshot = screen.getByRole("region", {
      name: "Plats et options commandés",
    });
    expect(snapshot).toHaveTextContent("1 × Riz");
    expect(snapshot.querySelector("small")).toHaveTextContent(
      "Options : Format : Grand",
    );
    expect(snapshot.closest(".df-total")).toBeNull();
    expect(
      screen.getByText("Total serveur").parentElement,
    ).not.toContainElement(snapshot);
  });
});
