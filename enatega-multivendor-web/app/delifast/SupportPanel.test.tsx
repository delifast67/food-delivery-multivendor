import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SupportPanel from "./SupportPanel";
import {
  delifastApi,
  DelifastApiError,
  type SupportTicket,
} from "@/lib/delifast/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const ticket: SupportTicket = {
  id: "ticket-1",
  customerId: "client-1",
  subject: "Plat manquant",
  description: "Il manque le riz.",
  status: "OPEN",
  version: 0,
  createdAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:00Z",
  history: [
    {
      status: "OPEN",
      at: "2026-10-20T08:00:00Z",
      actorRole: "CUSTOMER",
      note: "",
    },
  ],
};
const fill = () => {
  fireEvent.change(screen.getByLabelText("Objet de la réclamation"), {
    target: { value: ticket.subject },
  });
  fireEvent.change(screen.getByLabelText("Description du problème"), {
    target: { value: ticket.description },
  });
};
it("opens a ticket, sends only the authenticated payload, and shows its retained history", async () => {
  const list = vi
    .spyOn(delifastApi, "customerSupportTickets")
    .mockResolvedValueOnce([])
    .mockResolvedValue([ticket]);
  const create = vi
    .spyOn(delifastApi, "createSupportTicket")
    .mockResolvedValue(ticket);
  render(<SupportPanel token="client-token" />);
  await screen.findByText("Aucun ticket sur cette page.");
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Ouvrir un ticket" }));
  expect(await screen.findByRole("status")).toHaveTextContent("enregistré");
  expect(create).toHaveBeenCalledWith("client-token", {
    subject: ticket.subject,
    description: ticket.description,
    idempotencyKey: expect.any(String),
  });
  expect(list).toHaveBeenCalledWith("client-token", 20, 0);
  expect(
    await screen.findByRole("list", { name: "Historique du ticket ticket-1" }),
  ).toHaveTextContent("Ouvert");
  expect(
    screen.queryByRole("button", { name: "Prendre en charge" }),
  ).not.toBeInTheDocument();
});
it("retries an uncertain create with the same key and content, coalescing double taps", async () => {
  vi.spyOn(delifastApi, "customerSupportTickets").mockResolvedValue([]);
  const create = vi
    .spyOn(delifastApi, "createSupportTicket")
    .mockRejectedValueOnce(new Error("Réseau indisponible"))
    .mockResolvedValue(ticket);
  render(<SupportPanel token="client-token" />);
  await screen.findByText("Aucun ticket sur cette page.");
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Ouvrir un ticket" }));
  const retry = await screen.findByRole("button", {
    name: "Réessayer le même ticket",
  });
  expect(screen.getByLabelText("Objet de la réclamation")).toBeDisabled();
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(await screen.findByRole("status")).toHaveTextContent("enregistré");
});
it("admin advances one state with CAS and a customer-visible note", async () => {
  vi.spyOn(delifastApi, "operationsSupportTickets").mockResolvedValue([ticket]);
  const updated: SupportTicket = {
    ...ticket,
    status: "IN_PROGRESS",
    version: 1,
    history: [
      ...ticket.history,
      {
        status: "IN_PROGRESS",
        at: ticket.updatedAt,
        actorRole: "ADMIN",
        note: "Vérification en cours",
      },
    ],
  };
  const transition = vi
    .spyOn(delifastApi, "transitionSupportTicket")
    .mockResolvedValue(updated);
  render(<SupportPanel token="admin-token" admin />);
  const button = await screen.findByRole("button", {
    name: "Prendre en charge",
  });
  expect(
    screen.queryByLabelText("Objet de la réclamation"),
  ).not.toBeInTheDocument();
  fireEvent.change(
    screen.getByLabelText("Note visible par le client · ticket-1"),
    { target: { value: "Vérification en cours" } },
  );
  fireEvent.click(button);
  expect(
    await screen.findByRole("button", { name: "Résoudre le ticket" }),
  ).toBeInTheDocument();
  expect(transition).toHaveBeenCalledWith(
    "admin-token",
    ticket.id,
    0,
    "IN_PROGRESS",
    "Vérification en cours",
  );
  expect(
    screen.getByRole("list", { name: "Historique du ticket ticket-1" }),
  ).toHaveTextContent("Vérification en cours");
});
it("refreshes a stale ticket rather than silently retrying an admin transition", async () => {
  const resolved: SupportTicket = { ...ticket, status: "RESOLVED", version: 2 };
  const list = vi
    .spyOn(delifastApi, "operationsSupportTickets")
    .mockResolvedValueOnce([ticket])
    .mockResolvedValue([resolved]);
  const transition = vi
    .spyOn(delifastApi, "transitionSupportTicket")
    .mockRejectedValue(
      new DelifastApiError(
        "Conflit",
        "unknown",
        200,
        "CONCURRENT_MODIFICATION",
      ),
    );
  render(<SupportPanel token="admin-token" admin />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Prendre en charge" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ce ticket a changé",
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Prendre en charge" }),
    ).not.toBeInTheDocument(),
  );
  expect(transition).toHaveBeenCalledTimes(1);
});
it("does not restore private data after a token change or logout", async () => {
  let complete!: (rows: SupportTicket[]) => void;
  vi.spyOn(delifastApi, "customerSupportTickets")
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        }),
    )
    .mockResolvedValue([]);
  const { rerender } = render(<SupportPanel token="old-token" />);
  rerender(<SupportPanel token="new-token" />);
  await screen.findByText("Aucun ticket sur cette page.");
  await act(async () => complete([ticket]));
  expect(screen.queryByText(ticket.subject)).not.toBeInTheDocument();
  rerender(<SupportPanel token="" />);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});
it("clears private state on session revocation", async () => {
  vi.spyOn(delifastApi, "customerSupportTickets")
    .mockResolvedValueOnce([ticket])
    .mockRejectedValue(
      new DelifastApiError(
        "Connexion requise",
        "unknown",
        200,
        "UNAUTHENTICATED",
      ),
    );
  render(<SupportPanel token="revoked-token" />);
  await screen.findByText(ticket.subject);
  fireEvent.click(
    screen.getByRole("button", { name: "Actualiser les tickets" }),
  );
  expect(
    await screen.findByText("Reconnectez-vous pour accéder au support."),
  ).toBeInTheDocument();
  expect(screen.queryByText(ticket.description)).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Objet de la réclamation"),
  ).not.toBeInTheDocument();
});
it("loads safely in StrictMode and paginates bounded lists", async () => {
  const list = vi
    .spyOn(delifastApi, "customerSupportTickets")
    .mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ ...ticket, id: `ticket-${i}` })),
    );
  render(
    <StrictMode>
      <SupportPanel token="strict-token" />
    </StrictMode>,
  );
  const next = await screen.findByRole("button", { name: "Tickets suivants" });
  await waitFor(() => expect(next).not.toBeDisabled());
  fireEvent.click(next);
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith("strict-token", 20, 20),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Tickets précédents" }),
    ).not.toBeDisabled(),
  );
});

it("allows admin processing without an optional note", async () => {
  vi.spyOn(delifastApi, "operationsSupportTickets").mockResolvedValue([ticket]);
  const transition = vi
    .spyOn(delifastApi, "transitionSupportTicket")
    .mockResolvedValue({ ...ticket, version: 1, status: "IN_PROGRESS" });
  render(<SupportPanel token="admin-token" admin />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Prendre en charge" }),
  );
  await screen.findByRole("button", { name: "Résoudre le ticket" });
  expect(transition).toHaveBeenCalledWith(
    "admin-token",
    ticket.id,
    0,
    "IN_PROGRESS",
    "",
  );
});

it("admin identifies restaurant and rider creators without labelling them as customers", async () => {
  vi.spyOn(delifastApi, "operationsSupportTickets").mockResolvedValue([
    { ...ticket, id: "restaurant-ticket", customerId: null, creatorId: "staff-resto", creatorRole: "RESTAURANT", restaurantId: "resto-1" },
    { ...ticket, id: "rider-ticket", customerId: null, creatorId: "staff-rider", creatorRole: "RIDER", restaurantId: null },
  ]);
  render(<SupportPanel token="admin-token" admin />);
  expect(await screen.findByText(/restaurant staff-resto · établissement resto-1/)).toBeInTheDocument();
  expect(screen.getByText(/livreur staff-rider/)).toBeInTheDocument();
  expect(screen.queryByText(/client null/)).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Prendre en charge" })).toHaveLength(2);
});
