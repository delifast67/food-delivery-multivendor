import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperationsPage from "./page";
import {
  DelifastApiError,
  delifastApi,
  type Order,
  type StaffUser,
} from "@/lib/delifast/api";

const token = "staff-token";
const admin: StaffUser = { id: "a1", name: "Admin", role: "ADMIN" };
const restaurant: StaffUser = {
  id: "r1",
  name: "Restaurant",
  role: "RESTAURANT",
  restaurantId: "rest-1",
};
const rider: StaffUser = { id: "d1", name: "Livreur", role: "RIDER" };
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
const makeOrder = (status: string, riderId: string | null = null): Order => ({
  id: "o1",
  accessToken: "order-token",
  status,
  paymentStatus: "PAID",
  createdAt: "2025-01-01T00:00:00Z",
  restaurantId: "rest-1",
  checkout,
  riderId,
  history: [],
});

let order: Order;
let operationsOrders: any;
let me: any;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  order = makeOrder("ACCEPTED");
  operationsOrders = vi
    .spyOn(delifastApi, "operationsOrders")
    .mockResolvedValue([order]);
  me = vi.spyOn(delifastApi, "me").mockResolvedValue(restaurant);
  vi.spyOn(delifastApi, "availableRiders").mockResolvedValue([rider]);
  vi.spyOn(delifastApi, "staffLogin").mockResolvedValue({
    token,
    user: restaurant,
  });
  vi.spyOn(delifastApi, "staffLogout").mockResolvedValue(true);
  vi.spyOn(delifastApi, "transitionOrder").mockResolvedValue(order);
  vi.spyOn(delifastApi, "assignRider").mockResolvedValue({
    ...order,
    riderId: rider.id,
  });
  vi.spyOn(delifastApi, "simulateDemoPayment").mockResolvedValue({
    ...order,
    status: "CONFIRMED",
  });
});

afterEach(() => cleanup());

async function login() {
  render(<OperationsPage />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "team@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Mot de passe"), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));
  await screen.findByText("#o1");
}

async function openOrder() {
  await login();
  fireEvent.click(screen.getByRole("button", { name: /#o1/ }));
}

describe("connexion et session staff", () => {
  it("connecte avec succès, conserve le token uniquement en sessionStorage et restaure me", async () => {
    await login();
    expect(delifastApi.staffLogin).toHaveBeenCalledWith(
      "team@example.test",
      "secret",
    );
    expect(sessionStorage.getItem("delifast-staff-token")).toBe(token);
    expect(localStorage.getItem("delifast-staff-token")).toBeNull();
    expect(delifastApi.me).toHaveBeenCalledWith(token);
  });

  it("affiche l’échec de connexion sans écrire de token", async () => {
    vi.mocked(delifastApi.staffLogin).mockRejectedValue(
      new Error("Identifiants invalides"),
    );
    render(<OperationsPage />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "bad@test" },
    });
    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Identifiants invalides",
    );
    expect(sessionStorage.getItem("delifast-staff-token")).toBeNull();
  });

  it("restaure une session existante et nettoie toutes les données sur UNAUTHENTICATED", async () => {
    sessionStorage.setItem("delifast-staff-token", token);
    vi.mocked(delifastApi.me).mockRejectedValue(
      new DelifastApiError("Accès refusé", "unknown", 401, "UNAUTHENTICATED"),
    );
    render(<OperationsPage />);
    await waitFor(() =>
      expect(sessionStorage.getItem("delifast-staff-token")).toBeNull(),
    );
    expect(
      screen.getByRole("heading", { name: "Connexion équipe" }),
    ).toBeInTheDocument();
    expect(operationsOrders).toHaveBeenCalledWith(token);
  });

  it("déconnecte via API et indique honnêtement une révocation incertaine", async () => {
    await login();
    fireEvent.click(screen.getByRole("button", { name: "Se déconnecter" }));
    await screen.findByRole("heading", { name: "Connexion équipe" });
    expect(delifastApi.staffLogout).toHaveBeenCalledWith(token);
    expect(sessionStorage.getItem("delifast-staff-token")).toBeNull();

    cleanup();
    vi.mocked(delifastApi.staffLogin).mockResolvedValue({
      token,
      user: restaurant,
    });
    await login();
    vi.mocked(delifastApi.staffLogout).mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Se déconnecter" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "révocation serveur n’a pas pu être confirmée",
    );
  });
});

describe("permissions et mutations opérations", () => {
  it("n'affiche pas l'onglet Catalogue pour un rider", async () => {
    me.mockResolvedValue(rider);
    await login();
    expect(
      screen.queryByRole("tab", { name: "Catalogue" }),
    ).not.toBeInTheDocument();
  });

  it("permet au restaurant ses transitions mais jamais livraison, assignation ou paiement démo", async () => {
    await openOrder();
    expect(
      screen.getByRole("button", { name: /Passer à « En préparation »/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Livrée/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Assigner un livreur/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Simuler le paiement/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Passer à « En préparation »/ }),
    );
    expect(delifastApi.transitionOrder).toHaveBeenCalledWith(
      token,
      "o1",
      "PREPARING",
      "ACCEPTED",
    );
  });

  it("limite le rider affecté à READY puis PICKED_UP puis DELIVERED", async () => {
    me.mockResolvedValue(rider);
    order = makeOrder("READY", rider.id);
    operationsOrders.mockResolvedValue([order]);
    await openOrder();
    fireEvent.click(
      screen.getByRole("button", { name: /Passer à « Récupérée »/ }),
    );
    expect(delifastApi.transitionOrder).toHaveBeenCalledWith(
      token,
      "o1",
      "PICKED_UP",
      "READY",
    );
    expect(
      screen.queryByRole("button", { name: /Livrée/ }),
    ).not.toBeInTheDocument();

    cleanup();
    order = makeOrder("PICKED_UP", rider.id);
    operationsOrders.mockResolvedValue([order]);
    await openOrder();
    expect(
      screen.getByRole("button", { name: /Passer à « Livrée »/ }),
    ).toBeInTheDocument();
  });

  it("réserve l’assignation admin à ACCEPTED/PREPARING/READY et envoie expectedStatus", async () => {
    me.mockResolvedValue(admin);
    order = makeOrder("ACCEPTED");
    operationsOrders.mockResolvedValue([order]);
    await openOrder();
    fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
      target: { value: rider.id },
    });
    expect(delifastApi.assignRider).toHaveBeenCalledWith(
      token,
      "o1",
      rider.id,
      "ACCEPTED",
    );

    cleanup();
    order = makeOrder("DELIVERED");
    operationsOrders.mockResolvedValue([order]);
    await openOrder();
    expect(
      screen.queryByLabelText("Assigner un livreur"),
    ).not.toBeInTheDocument();
  });

  it("ne modifie pas optimistement sur erreur et recharge sur conflit en gardant le message", async () => {
    me.mockResolvedValue(admin);
    order = makeOrder("ACCEPTED");
    operationsOrders.mockResolvedValue([order]);
    vi.mocked(delifastApi.transitionOrder).mockRejectedValue(
      new DelifastApiError(
        "Statut concurrent",
        "unknown",
        409,
        "CONCURRENT_MODIFICATION",
      ),
    );
    await openOrder();
    fireEvent.click(
      screen.getByRole("button", { name: /Passer à « En préparation »/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La commande a changé",
    );
    expect(delifastApi.operationsOrders).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Acceptée")).toBeInTheDocument();
  });

  it("désactive les actions pendant une mutation et empêche le double clic", async () => {
    let resolve: (value: Order) => void = () => undefined;
    vi.mocked(delifastApi.transitionOrder).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await openOrder();
    const button = screen.getByRole("button", {
      name: /Passer à « En préparation »/,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(delifastApi.transitionOrder).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    resolve({ ...order, status: "PREPARING" });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("actualisation et polling", () => {
  it("nettoie le polling au démontage", async () => {
    await login();
    vi.useFakeTimers();
    const calls = operationsOrders.mock.calls.length;
    cleanup();
    vi.advanceTimersByTime(60000);
    expect(operationsOrders).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
  });
});
