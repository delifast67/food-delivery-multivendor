import { afterEach, expect, it, vi } from "vitest";
import { delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("utilise une page serveur de 20 et un détail séparé via le proxy authentifié", async () => {
  const page = { items: [{ id: "r21", name: "Livreur" }], nextCursor: "r21" };
  const rider = {
    id: "r21",
    name: "Livreur",
    role: "RIDER",
    restaurantId: null,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { operationsRiderSummaries: page, operationsRider: rider },
      }),
    });
  vi.stubGlobal("fetch", fetchMock);
  expect(await delifastApi.operationsRiderSummaries("admin")).toEqual(page);
  await delifastApi.operationsRiderSummaries("admin", "r20", "r21");
  expect(await delifastApi.operationsRider("admin", "r21")).toEqual(rider);
  const bodies = fetchMock.mock.calls.map(([url, init]) => {
    expect(url).toBe("/api/delifast/graphql");
    expect(init.headers.authorization).toBe("Bearer admin");
    return JSON.parse(init.body);
  });
  expect(bodies[0].variables).toEqual({ after: null, riderId: null });
  expect(bodies[0].query).toContain("limit: 20");
  expect(bodies[0].query).toContain("items { id name }");
  expect(bodies[0].query).not.toMatch(
    /availableRiders|restaurantId|role|password|email/,
  );
  expect(bodies[1].variables).toEqual({ after: "r20", riderId: "r21" });
  expect(bodies[2].variables).toEqual({ id: "r21" });
  expect(bodies[2].query).toContain("operationsRider(id: $id)");
});
it("conserve l’helper legacy sans lui ajouter de limite implicite", async () => {
  const legacy = Array.from({ length: 65 }, (_, n) => ({
    id: `r${n}`,
    name: "Livreur",
    role: "RIDER",
  }));
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { availableRiders: legacy } }),
    });
  vi.stubGlobal("fetch", fetchMock);
  expect(await delifastApi.availableRiders("admin")).toEqual(legacy);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.query).toContain("availableRiders { id name role restaurantId }");
  expect(body.query).not.toMatch(/limit|after/);
});
