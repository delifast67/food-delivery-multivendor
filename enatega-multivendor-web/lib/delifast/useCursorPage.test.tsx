import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCursorPage } from "./useCursorPage";

type Row = { id: string; name: string };
const row = (id: string, name = id) => ({ id, name });
const page = (items: Row[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Pages publiques indépendantes et bornées", () => {
  it("déduplique les frontières et conserve les éléments lors d'une suite", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce(page([row("1"), row("2")], "next"))
      .mockResolvedValueOnce(page([row("2", "actualisé"), row("3")]));
    const { result } = renderHook(() =>
      useCursorPage("restaurant", true, loader),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.more());
    await waitFor(() =>
      expect(result.current.items).toEqual([
        row("1"),
        row("2", "actualisé"),
        row("3"),
      ]),
    );
    expect(loader.mock.calls).toEqual([[null], ["next"]]);
    expect(result.current.cursor).toBeNull();
  });

  it("une page vide filtrée ne masque pas la suite", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce(page([], "next"))
      .mockResolvedValueOnce(page([row("3")]));
    const { result } = renderHook(() => useCursorPage("point", true, loader));
    await waitFor(() => expect(result.current.cursor).toBe("next"));
    expect(result.current.items).toEqual([]);
    act(() => result.current.more());
    await waitFor(() => expect(result.current.items).toEqual([row("3")]));
  });

  it("conserve la même page après erreur de suite et reprend le curseur exact", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce(page([row("1")], "next"))
      .mockRejectedValueOnce(new Error("hors ligne"))
      .mockResolvedValueOnce(page([row("2")]));
    const { result } = renderHook(() => useCursorPage("scope", true, loader));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.more());
    await waitFor(() => expect(result.current.error).toBe("hors ligne"));
    expect(result.current.items).toEqual([row("1")]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(loader.mock.calls).toEqual([[null], ["next"], ["next"]]);
    expect(result.current.error).toBe("");
  });

  it("ignore une réponse ancienne et ne montre pas de résultats sous un autre filtre", async () => {
    const old = deferred<ReturnType<typeof page>>();
    const fresh = deferred<ReturnType<typeof page>>();
    const loader = vi.fn((scope: string) =>
      scope === "old" ? old.promise : fresh.promise,
    );
    const { result, rerender } = renderHook(
      ({ scope }) => useCursorPage(scope, true, () => loader(scope)),
      { initialProps: { scope: "old" } },
    );
    rerender({ scope: "new" });
    expect(result.current.items).toEqual([]);
    await act(async () => fresh.resolve(page([row("new")])));
    expect(result.current.items).toEqual([row("new")]);
    await act(async () => old.resolve(page([row("old")], "old-cursor")));
    expect(result.current.items).toEqual([row("new")]);
    expect(result.current.cursor).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("retire les données d'une recherche précédente même si la nouvelle échoue", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce(page([row("old")]))
      .mockRejectedValueOnce(new Error("recherche indisponible"));
    const { result, rerender } = renderHook(
      ({ scope }) => useCursorPage(scope, true, loader),
      { initialProps: { scope: "old" } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    rerender({ scope: "new" });
    expect(result.current.items).toEqual([]);
    await waitFor(() =>
      expect(result.current.error).toBe("recherche indisponible"),
    );
    expect(result.current.items).toEqual([]);
    expect(loader.mock.calls).toEqual([[null], [null]]);
  });

  it("verrouille synchroniquement les doubles demandes et annule une portée désactivée", async () => {
    const later = deferred<ReturnType<typeof page>>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(page([row("1")], "next"))
      .mockImplementationOnce(() => later.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useCursorPage("scope", enabled, loader),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.more();
      result.current.more();
    });
    expect(loader).toHaveBeenCalledTimes(2);
    rerender({ enabled: false });
    await act(async () => later.resolve(page([row("2")])));
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
