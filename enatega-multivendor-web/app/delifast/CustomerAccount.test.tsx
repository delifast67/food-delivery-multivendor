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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerAccount from "./CustomerAccount";
import { DelifastApiError, delifastApi } from "@/lib/delifast/api";

afterEach(() => {
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
