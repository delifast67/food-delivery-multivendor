import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryAddressInput, delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

const address = {
  recipientName: "Client test",
  phone: "+22670123456",
  city: "Ouagadougou",
  neighborhood: "Koulouba",
  landmark: "Mairie",
  instructions: "Appeler",
  point: { latitude: 12.3, longitude: -1.5 },
};

const responses = {
  customerMe: { id: "customer-test", phone: address.phone },
  customerAddresses: [{ id: "address-test", ...address }],
  requestCustomerOtp: {
    challengeId: "test-challenge",
    expiresIn: 60,
    retryAfter: 2,
  },
  resendCustomerOtp: {
    challengeId: "test-challenge-2",
    expiresIn: 60,
    retryAfter: 2,
  },
  verifyCustomerOtp: {
    token: "test-session-token",
    customer: { id: "customer-test", phone: address.phone },
  },
  customerLogout: true,
  createCustomerAddress: { id: "address-test", ...address },
  updateCustomerAddress: { id: "address-test", ...address },
  deleteCustomerAddress: true,
};

function stubSuccessfulFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: responses }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("customer transport protocol", () => {
  it.each([
    ["customerMe", () => delifastApi.customerMe("private-token"), true],
    [
      "customerAddresses",
      () => delifastApi.customerAddresses("private-token"),
      true,
    ],
    [
      "updateCustomerProfile",
      () =>
        delifastApi.updateCustomerProfile("private-token", {
          firstName: "Ada",
          lastName: null,
          email: null,
        }),
      true,
    ],
    [
      "requestCustomerOtp",
      () => delifastApi.requestCustomerOtp(address.phone),
      false,
    ],
    [
      "resendCustomerOtp",
      () => delifastApi.resendCustomerOtp("test-challenge"),
      false,
    ],
    [
      "verifyCustomerOtp",
      () => delifastApi.verifyCustomerOtp("test-challenge", "123456"),
      false,
    ],
    ["customerLogout", () => delifastApi.customerLogout("private-token"), true],
    [
      "createCustomerAddress",
      () => delifastApi.createCustomerAddress("private-token", address),
      true,
    ],
    [
      "updateCustomerAddress",
      () =>
        delifastApi.updateCustomerAddress(
          "private-token",
          "address-test",
          address,
        ),
      true,
    ],
    [
      "deleteCustomerAddress",
      () => delifastApi.deleteCustomerAddress("private-token", "address-test"),
      true,
    ],
  ] as const)(
    "sends the %s operation with the correct bearer policy",
    async (operation, invoke, privateOperation) => {
      const fetchMock = stubSuccessfulFetch();
      await invoke();
      const [, init] = fetchMock.mock.calls[0] as [string, NonNullable<Parameters<typeof fetch>[1]>];
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      expect(body.query).toContain(operation);
      const headers = init.headers as Record<string, string>;
      if (privateOperation)
        expect(headers.authorization).toBe("Bearer private-token");
      else expect(headers.authorization).toBeUndefined();
    },
  );

  it("whitelists DeliveryAddressInput fields and strips point extras", () => {
    const input = deliveryAddressInput({
      ...address,
      id: "must-not-send",
      customerId: "must-not-send",
      _id: "must-not-send",
      createdAt: "must-not-send",
      version: 99,
      point: {
        latitude: 12.3,
        longitude: -1.5,
        altitude: 10,
        label: "test-only-extra",
      } as never,
      extra: "must-not-send",
    } as never);
    expect(input).toEqual({
      recipientName: address.recipientName,
      phone: address.phone,
      city: address.city,
      neighborhood: address.neighborhood,
      landmark: address.landmark,
      instructions: address.instructions,
      point: { latitude: 12.3, longitude: -1.5 },
    });
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("customerId");
    expect(input).not.toHaveProperty("_id");
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("version");
  });

  it("whitelists nullable CustomerProfileInput fields and requires authentication", async () => {
    const fetchMock = stubSuccessfulFetch();
    await delifastApi.updateCustomerProfile("private-token", {
      firstName: "Ada",
      lastName: null,
      email: null,
      id: "must-not-send",
      phone: "+22600000000",
    } as never);
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      NonNullable<Parameters<typeof fetch>[1]>,
    ];
    const body = JSON.parse(String(init.body)) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input).toEqual({
      firstName: "Ada",
      lastName: null,
      email: null,
    });
    expect(body.variables.input).not.toHaveProperty("id");
    expect(body.variables.input).not.toHaveProperty("phone");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer private-token",
    );
  });

  it("propagates provider error code from GraphQL without generating or displaying an OTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        errors: [
          {
            message: "Provider unavailable",
            extensions: { code: "OTP_PROVIDER_UNAVAILABLE" },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      delifastApi.requestCustomerOtp(address.phone),
    ).rejects.toMatchObject({
      code: "OTP_PROVIDER_UNAVAILABLE",
      kind: "unavailable",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, NonNullable<Parameters<typeof fetch>[1]>];
    const body = JSON.parse(String(init.body)) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({ phone: address.phone });
    expect(body.variables).not.toHaveProperty("code");
  });

  it("strips saved-address metadata when serializing an order operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { placeOrder: { id: "protocol-order" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.placeOrder({
      restaurantId: "protocol-restaurant",
      items: [{ menuItemId: "protocol-item", quantity: 1 }],
      idempotencyKey: "protocol-idempotency-key",
      expectedQuoteHash: "c".repeat(64),
      expectedQuoteToken: "opaque-token",
      deliveryAddress: {
        ...address,
        id: "server-address-id",
        customerId: "server-owner",
        createdAt: "server-time",
      } as typeof address,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, NonNullable<Parameters<typeof fetch>[1]>];
    const payload = JSON.parse(String(init.body));
    expect(payload.variables.input.deliveryAddress).toEqual(
      deliveryAddressInput(address),
    );
    expect(payload.variables.input.deliveryAddress).not.toHaveProperty("id");
    expect(payload.variables.input.deliveryAddress).not.toHaveProperty(
      "customerId",
    );
    expect(payload.variables.input.deliveryAddress).not.toHaveProperty(
      "createdAt",
    );
  });

  it("rejects an incomplete OTP success instead of treating it as a challenge", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { requestCustomerOtp: { challengeId: "" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(delifastApi.requestCustomerOtp(address.phone)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
