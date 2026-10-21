import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("verrou de démarrage production existant, pas un détecteur de commandes réelles", () => {
  it("refuse de charger la configuration production avec son erreur actuelle", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow(
      "Ce lot Delifast est réservé au développement local : authentification et paiements de production non disponibles.",
    );
  });

  it.each(["development", "test", undefined])("préserve la configuration NODE_ENV=%s sans la déclarer sûre pour le réel", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    vi.resetModules();
    await expect(import("../src/config.js")).resolves.toHaveProperty("config");
  });

  it("ne déduit pas le mode production de HOST, d’une URI distante ou des réglages de paiement", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HOST", "0.0.0.0");
    vi.stubEnv("MONGODB_URI", "mongodb://remote.invalid/example");
    vi.stubEnv("PAYMENT_PROVIDER", "paydunya");
    vi.stubEnv("PAYDUNYA_LIVE_AUTHORIZED", "true");
    vi.resetModules();
    // Import configuration only: no DB connection or provider instantiation.
    const { config } = await import("../src/config.js");
    expect(config.host).toBe("0.0.0.0");
    expect(config.mongoUri).toBe("mongodb://remote.invalid/example");
  });

  it("le mode démo ne contourne pas le refus de démarrage production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DELIFAST_DEMO_PAYMENTS", "true");
    vi.stubEnv("DELIFAST_LOCAL_MODE", "true");
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow("réservé au développement local");
  });
});
