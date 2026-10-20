import { afterEach, expect, it, vi } from "vitest";
import { delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("sends support operations through the local proxy with bearer auth and CAS", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        customerSupportTickets: [],
        operationsSupportTickets: [],
        createSupportTicket: { id: "t1" },
        transitionSupportTicket: { id: "t1" },
      },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  await delifastApi.customerSupportTickets("client", 20, 40);
  await delifastApi.operationsSupportTickets("admin");
  const input = {
    subject: "Objet",
    description: "Problème",
    idempotencyKey: "support-test-key-001",
  };
  await delifastApi.createSupportTicket("client", input);
  await delifastApi.transitionSupportTicket(
    "admin",
    "t1",
    0,
    "IN_PROGRESS",
    "Examen",
  );
  const bodies = fetchMock.mock.calls.map(([url, init]) => {
    expect(url).toBe("/api/delifast/graphql");
    expect(init.headers.authorization).toMatch(/^Bearer (client|admin)$/);
    return JSON.parse(init.body);
  });
  expect(bodies[0].variables).toEqual({ limit: 20, offset: 40 });
  expect(bodies[1].variables).toEqual({ limit: 20, offset: 0 });
  expect(bodies[2].variables).toEqual({ input });
  expect(bodies[2].query).not.toContain("customerId:");
  expect(bodies[3].variables).toEqual({
    id: "t1",
    expectedVersion: 0,
    status: "IN_PROGRESS",
    note: "Examen",
  });
});
