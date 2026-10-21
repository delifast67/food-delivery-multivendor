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
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow("réservé au développement local");
  });
});

describe("opt-in non atomique strict et indépendant du mode local", () => {
  it.each(["development", "test", undefined])("reste fermé sans opt-in en NODE_ENV=%s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", undefined);
    vi.stubEnv("DELIFAST_DEMO_PAYMENTS", "true");
    vi.stubEnv("DELIFAST_LOCAL_MODE", "true");
    const { config } = await import("../src/config.js");
    expect(config.isNonatomicCheckoutAllowed()).toBe(false);
  });

  it.each([undefined, "", "false", "FALSE", "0", "1", "yes", "TRUE", "True", " true", "true ", "tru", "null", "undefined"])("échoue fermé pour la valeur %s", async value => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", value);
    const { config } = await import("../src/config.js");
    expect(config.isNonatomicCheckoutAllowed()).toBe(false);
    // Service-level guard precedes any database access, including recovery.
    const { placeOrder } = await import("../src/orders.js");
    const collection = vi.fn();
    await expect(placeOrder({ collection } as any, {} as any, {} as any, "blocked-order-key"))
      .rejects.toMatchObject({ extensions: { code: "CHECKOUT_DISABLED" } });
    expect(collection).not.toHaveBeenCalled();
  });

  it.each(["development", "test", undefined])("n’autorise que true explicite en NODE_ENV=%s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    const { config } = await import("../src/config.js");
    expect(config.isNonatomicCheckoutAllowed()).toBe(true);
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "false");
    expect(config.isNonatomicCheckoutAllowed()).toBe(false);
  });
});
