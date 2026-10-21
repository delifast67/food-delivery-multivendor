import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { delifastApi, type Order } from "@/lib/delifast/api";
import RiderPicker from "./RiderPicker";
import type { MockInstance } from "vitest";

const order = { id: "o1", status: "READY", riderId: null } as Order;
const rider = { id: "d001", name: "Livreur 1", role: "RIDER" };
let list: MockInstance<typeof delifastApi.operationsRiderSummaries>;
let detail: MockInstance<typeof delifastApi.operationsRider>;
let assign: ReturnType<typeof vi.fn>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.restoreAllMocks();
  list = vi
    .spyOn(delifastApi, "operationsRiderSummaries")
    .mockResolvedValue({
      items: [{ id: rider.id, name: rider.name }],
      nextCursor: null,
    });
  detail = vi.spyOn(delifastApi, "operationsRider").mockResolvedValue(rider);
  assign = vi.fn().mockResolvedValue(undefined);
});
afterEach(cleanup);
function mount() {
  return render(
    <RiderPicker token="admin-token" order={order} busy="" onAssign={assign} />,
  );
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByLabelText("Assigner un livreur")).not.toBeDisabled(),
  );
}

it("charge une page minimale à la demande, sans détail ni legacy", async () => {
  const legacy = vi.spyOn(delifastApi, "availableRiders");
  mount();
  await ready();
  expect(list).toHaveBeenCalledExactlyOnceWith("admin-token", null, null);
  expect(detail).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
});
it("remplace la page, revient en arrière et recherche un ID hors première page", async () => {
  list
    .mockResolvedValueOnce({
      items: [{ id: rider.id, name: rider.name }],
      nextCursor: rider.id,
    })
    .mockResolvedValueOnce({
      items: [{ id: "d021", name: "Livreur 21" }],
      nextCursor: null,
    });
  mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Livreurs suivants" }));
  await ready();
  expect(list).toHaveBeenLastCalledWith("admin-token", rider.id, null);
  expect(
    screen.queryByRole("option", { name: rider.name }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Livreurs précédents" }));
  await ready();
  expect(list).toHaveBeenLastCalledWith("admin-token", null, null);
  fireEvent.change(screen.getByLabelText("ID livreur exact"), {
    target: { value: " d099 " },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Rechercher le livreur" }),
  );
  await ready();
  expect(list).toHaveBeenLastCalledWith("admin-token", null, "d099");
  fireEvent.click(
    screen.getByRole("button", { name: "Réinitialiser les livreurs" }),
  );
  await ready();
  expect(list).toHaveBeenLastCalledWith("admin-token", null, null);
  expect(screen.getByLabelText("ID livreur exact")).toHaveValue("");
});
it("affiche honnêtement le résultat vide", async () => {
  list.mockResolvedValue({ items: [], nextCursor: null });
  mount();
  await ready();
  expect(screen.getByText("Aucun livreur actif trouvé.")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Livreurs suivants" }),
  ).toBeDisabled();
});
it("ne garde pas des options périmées après erreur et permet la reprise explicite", async () => {
  list
    .mockResolvedValueOnce({
      items: [{ id: rider.id, name: rider.name }],
      nextCursor: rider.id,
    })
    .mockRejectedValueOnce(new Error("Réseau indisponible"));
  mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Livreurs suivants" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Réseau indisponible",
  );
  expect(
    screen.queryByRole("option", { name: rider.name }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Réinitialiser les livreurs" }),
  );
  await ready();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each([null, { ...rider, id: "other" }, { ...rider, role: "ADMIN" }])(
  "refuse un détail absent ou incohérent %#",
  async (result) => {
    detail.mockResolvedValue(result);
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
      target: { value: rider.id },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Livreur indisponible",
    );
    expect(assign).not.toHaveBeenCalled();
  },
);
it("ne déclenche aucune affectation si la vérification échoue", async () => {
  detail.mockRejectedValue(new Error("Accès refusé"));
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
    target: { value: rider.id },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Accès refusé");
  expect(assign).not.toHaveBeenCalled();
});
it("vérifie avant mutation, verrouille les doublons et ignore la vérification après démontage", async () => {
  const pending = deferred<typeof rider>();
  detail.mockReturnValue(pending.promise);
  const view = mount();
  await ready();
  fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
    target: { value: rider.id },
  });
  fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
    target: { value: rider.id },
  });
  expect(detail).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Assigner un livreur")).toBeDisabled();
  view.unmount();
  await act(async () => pending.resolve(rider));
  expect(assign).not.toHaveBeenCalled();
});
it("ignore une ancienne page après changement de session", async () => {
  const pending = deferred<{
    items: { id: string; name: string }[];
    nextCursor: null;
  }>();
  list.mockReturnValueOnce(pending.promise);
  const view = mount();
  view.rerender(
    <RiderPicker token="new-admin" order={order} busy="" onAssign={assign} />,
  );
  await ready();
  await act(async () =>
    pending.resolve({
      items: [{ id: "old", name: "Ancienne session" }],
      nextCursor: null,
    }),
  );
  expect(
    screen.queryByRole("option", { name: "Ancienne session" }),
  ).not.toBeInTheDocument();
});
it("ne charge pas le catalogue pour une affectation définitive", async () => {
  render(
    <RiderPicker
      token="admin-token"
      order={{ ...order, riderId: "d099" }}
      busy=""
      onAssign={assign}
    />,
  );
  expect(list).not.toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Assigner un livreur")).toBeDisabled();
  expect(screen.getByRole("option", { name: "d099" })).toBeInTheDocument();
});
it("affecte après vérification exacte en conservant l’ID", async () => {
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText("Assigner un livreur"), {
    target: { value: rider.id },
  });
  await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(rider.id));
  expect(detail).toHaveBeenCalledExactlyOnceWith("admin-token", rider.id);
});
