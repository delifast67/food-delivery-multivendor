import { ApolloClient, ApolloLink, InMemoryCache } from "@apollo/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getSecureItem } from "./secure-storage";
import {
  PUBLIC_ACCESS_NONCE,
  PUBLIC_ACCESS_TOKEN,
} from "../utils/constants/local-storage";
import service from "./public-access-token.service";

jest.mock("react-native-get-random-values", () => ({}));
jest.mock("expo-device", () => ({ osBuildId: "test-device" }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
}));
jest.mock("./secure-storage", () => ({
  getSecureItem: jest.fn(),
  setSecureItem: jest.fn(),
  removeSecureItem: jest.fn(),
}));

const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: ApolloLink.empty(),
});
const result = {
  data: {
    metricsGeneral: { experience: "new-token", hehe: "2099-01-01T00:00:00Z" },
  },
};

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(getSecureItem).mockImplementation(async (key) => {
    if (key.startsWith(PUBLIC_ACCESS_NONCE)) return "nonce";
    if (key.startsWith(PUBLIC_ACCESS_TOKEN)) return "stored-token";
    return String(new Date("2099-01-01T00:00:00Z").getTime());
  });
  jest.mocked(AsyncStorage.getItem).mockResolvedValue("fr");
  await service.clearTokens();
  await service.initialize(client, "local-test");
});

afterEach(() => {
  service.pause();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("shares concurrent refresh work and clears it after success", async () => {
  const mutate = jest.spyOn(client, "mutate").mockResolvedValue(result);
  await Promise.all([
    service.refreshToken(client),
    service.refreshToken(client),
  ]);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(await service.getToken(client)).toBe("new-token");
  await service.refreshToken(client);
  expect(mutate).toHaveBeenCalledTimes(2);
});

it("allows retry after a rejected mutation without retaining the failed promise", async () => {
  const mutate = jest
    .spyOn(client, "mutate")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(result);
  await expect(service.refreshToken(client)).rejects.toThrow("offline");
  await service.refreshToken(client);
  expect(mutate).toHaveBeenCalledTimes(2);
});

it("clears refresh work after an early storage failure too", async () => {
  const mutate = jest.spyOn(client, "mutate").mockResolvedValue(result);
  jest
    .mocked(AsyncStorage.getItem)
    .mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(service.refreshToken(client)).rejects.toThrow(
    "storage unavailable",
  );
  await service.refreshToken(client);
  expect(mutate).toHaveBeenCalledTimes(1);
});
