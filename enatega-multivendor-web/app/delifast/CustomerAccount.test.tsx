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
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomerAccount from "./CustomerAccount";
import { DelifastApiError, delifastApi } from "@/lib/delifast/api";

afterEach(async () => {
  const logout = screen.queryByRole("button", { name: "Se déconnecter" });
  if (logout) {
    vi.spyOn(delifastApi, "customerLogout").mockResolvedValue(true);
    await act(async () => fireEvent.click(logout));
  }
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const openAccount = () => {
  render(<CustomerAccount />);
  fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));
};

const unavailable = () => new Error("OTP_PROVIDER unavailable");

describe("CustomerAccount OTP UX", () => {
  it("does not call the provider for an invalid phone number", () => {
    const request = vi.spyOn(delifastApi, "requestCustomerOtp");
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "070123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("+226XXXXXXXX");
  });

  it("shows the exact unavailable message and no challenge when the provider is absent", async () => {
    vi.spyOn(delifastApi, "requestCustomerOtp").mockRejectedValue(
      unavailable(),
    );
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La connexion réelle est momentanément indisponible.",
    );
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/message envoyé|code reçu|compte connecté/i),
    ).not.toBeInTheDocument();
  });

  it("maps a network failure to the same unavailable UX", async () => {
    vi.spyOn(delifastApi, "requestCustomerOtp").mockRejectedValue(
      new DelifastApiError(
        "Backend Delifast local indisponible",
        "unavailable",
      ),
    );
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La connexion réelle est momentanément indisponible.",
    );
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("keeps provider failure visible under React StrictMode", async () => {
    vi.spyOn(delifastApi, "requestCustomerOtp").mockRejectedValue(
      unavailable(),
    );
    render(
      <StrictMode>
        <CustomerAccount />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La connexion réelle est momentanément indisponible.",
    );
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("coalesces a double tap into one request and renders only protocol challenge metadata", async () => {
    let resolve: (value: {
      challengeId: string;
      expiresIn: number;
      retryAfter: number;
    }) => void = () => undefined;
    const request = vi
      .spyOn(delifastApi, "requestCustomerOtp")
      .mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    const button = screen.getByRole("button", {
      name: "Demander une connexion",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(request).toHaveBeenCalledTimes(1);
    resolve({ challengeId: "test-challenge", expiresIn: 3, retryAfter: 2 });
    expect(await screen.findByLabelText("Code")).toBeInTheDocument();
    expect(screen.getByText(/avant expiration \(3s\)/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Renvoyer dans 2s/ }),
    ).toBeDisabled();
    expect(screen.queryByText(/123456/)).not.toBeInTheDocument();
  });

  it("counts down cooldown, expires the challenge, and restart returns to phone entry", async () => {
    vi.useFakeTimers();
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue({
      challengeId: "test-challenge",
      expiresIn: 5,
      retryAfter: 2,
    });
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Code")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Renvoyer dans 2s/ }),
    ).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Renvoyer" })).not.toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Vérifier" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recommencer / changer de téléphone",
      }),
    );
    expect(screen.getByLabelText("Téléphone")).toBeInTheDocument();
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("accepts exactly six numeric characters, clears them on verify, and never treats rejection as success", async () => {
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue({
      challengeId: "test-challenge",
      expiresIn: 60,
      retryAfter: 0,
    });
    const verify = vi
      .spyOn(delifastApi, "verifyCustomerOtp")
      .mockRejectedValue(new Error("Code incorrect"));
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: "+22670123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Demander une connexion" }),
    );
    const code = await screen.findByLabelText("Code");
    fireEvent.change(code, { target: { value: "12a345678" } });
    expect(code).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: "Vérifier" }));
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith("test-challenge", "123456"),
    );
    expect(code).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Code incorrect");
    expect(
      screen.getByRole("button", { name: "Se connecter" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Mon compte")).not.toBeInTheDocument();
  });
});

describe("CustomerAccount deadlines and session isolation", () => {
  const challenge = {
    challengeId: "clock-test",
    expiresIn: 60,
    retryAfter: 30,
  };
  const customer = { id: "customer-local-test", phone: "+22670123456" };
  const address = {
    id: "private-address",
    recipientName: "Client fictif",
    phone: "+22670123456",
    city: "Ouagadougou",
    neighborhood: "Quartier fictif",
    landmark: "Repère fictif",
    instructions: "Instructions privées fictives",
    point: { latitude: 12.3714, longitude: -1.5197 },
  };
  const start = async () => {
    openAccount();
    fireEvent.change(screen.getByLabelText("Téléphone"), {
      target: { value: customer.phone },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Demander une connexion" }),
      );
    });
  };
  const signIn = async () => {
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue(challenge);
    vi.spyOn(delifastApi, "verifyCustomerOtp").mockResolvedValue({
      token: "private-test-token",
      customer,
    });
    vi.spyOn(delifastApi, "customerMe").mockResolvedValue(customer);
    vi.spyOn(delifastApi, "customerAddresses").mockResolvedValue([address]);
    await start();
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "123456" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Vérifier" }));
    });
    expect(screen.getByText(address.recipientName)).toBeInTheDocument();
  };
  const fillAddress = () => {
    for (const [label, value] of [
      ["Nom", "Autre client fictif"],
      ["Téléphone +226XXXXXXXX", customer.phone],
      ["Quartier", "Autre quartier"],
      ["Repère", "Autre repère"],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };
  const revoked = () =>
    new DelifastApiError(
      "Connexion requise.",
      "unknown",
      200,
      "UNAUTHENTICATED",
    );

  it("expires immediately on focus after suspended background timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue(challenge);
    await start();
    expect(screen.getByText(/avant expiration \(60s\)/)).toBeInTheDocument();
    act(() => {
      vi.setSystemTime(new Date("2026-10-20T07:02:00Z"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText(/avant expiration \(0s\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vérifier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Renvoyer" })).toBeDisabled();
  });

  it("checks the deadline at submission even before a resumed timer fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue(challenge);
    const verify = vi.spyOn(delifastApi, "verifyCustomerOtp");
    await start();
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "123456" },
    });
    vi.setSystemTime(new Date("2026-10-20T07:02:00Z"));
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Code").closest("form")!);
    });
    expect(verify).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cette demande a expiré",
    );
  });

  it("refreshes cooldown on visibility restoration without extending the OTP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
    vi.spyOn(delifastApi, "requestCustomerOtp").mockResolvedValue(challenge);
    await start();
    act(() => {
      vi.setSystemTime(new Date("2026-10-20T07:00:40Z"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText(/avant expiration \(20s\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Renvoyer" })).not.toBeDisabled();
  });

  it("subtracts network latency instead of starting a new full lifetime on receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
    let resolve!: (value: typeof challenge) => void;
    vi.spyOn(delifastApi, "requestCustomerOtp").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await start();
    await act(async () => {
      vi.setSystemTime(new Date("2026-10-20T07:00:10Z"));
      resolve(challenge);
    });
    expect(screen.getByText(/avant expiration \(50s\)/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Renvoyer dans 20s" }),
    ).toBeDisabled();
  });

  it.each(["create", "update", "delete"])(
    "clears private account data after revoked session on %s",
    async (operation) => {
      await signIn();
      if (operation === "delete") {
        vi.spyOn(delifastApi, "deleteCustomerAddress").mockRejectedValue(
          revoked(),
        );
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Supprimer" })),
        );
      } else {
        if (operation === "update") {
          fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
          vi.spyOn(delifastApi, "updateCustomerAddress").mockRejectedValue(
            revoked(),
          );
        } else {
          fillAddress();
          vi.spyOn(delifastApi, "createCustomerAddress").mockRejectedValue(
            revoked(),
          );
        }
        await act(async () =>
          fireEvent.click(
            screen.getByRole("button", {
              name: operation === "update" ? "Enregistrer" : "Ajouter",
            }),
          ),
        );
      }
      expect(screen.getByLabelText("Téléphone")).toBeInTheDocument();
      expect(screen.queryByText(address.recipientName)).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Mon compte" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Connexion requise");
    },
  );

  it("keeps the account after a network outage rather than treating it as revocation", async () => {
    await signIn();
    fillAddress();
    vi.spyOn(delifastApi, "createCustomerAddress").mockRejectedValue(
      new DelifastApiError("Backend indisponible", "unavailable", 503),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Ajouter" })),
    );
    expect(screen.getByText(address.recipientName)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mon compte" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nom")).toHaveValue("Autre client fictif");
  });

  it("discards the edit form when its address is deleted", async () => {
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    vi.spyOn(delifastApi, "deleteCustomerAddress").mockResolvedValue(true);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Supprimer" })),
    );
    expect(
      screen.getByRole("heading", { name: "Nouvelle adresse" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nom")).toHaveValue("");
    expect(screen.queryByText(address.recipientName)).not.toBeInTheDocument();
  });

  it("ignores a successful address response received after logout", async () => {
    await signIn();
    fillAddress();
    let resolve!: (value: typeof address) => void;
    vi.spyOn(delifastApi, "createCustomerAddress").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    vi.spyOn(delifastApi, "customerLogout").mockResolvedValue(true);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Se déconnecter" })),
    );
    await act(async () => resolve(address));
    expect(screen.getByLabelText("Téléphone")).toBeInTheDocument();
    expect(screen.queryByText(address.recipientName)).not.toBeInTheDocument();
  });
});
