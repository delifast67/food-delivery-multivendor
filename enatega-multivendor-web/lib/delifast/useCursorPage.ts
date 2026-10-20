"use client";

import { useEffect, useRef, useState } from "react";

type Page<T> = { items: T[]; nextCursor: string | null };
type State<T> = {
  scope: string;
  items: T[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string;
};
const unique = <T extends { id: string }>(items: T[]) =>
  Array.from(new Map(items.map((item) => [item.id, item])).values());

/** Une lecture indépendante par portée. La suite ne remplace jamais une autre recherche. */
export function useCursorPage<T extends { id: string }>(
  scope: string,
  enabled: boolean,
  loader: (after: string | null) => Promise<Page<T>>,
  merge: (items: T[]) => T[] = unique,
) {
  const [state, setState] = useState<State<T>>({
    scope: "",
    items: [],
    cursor: null,
    loading: false,
    loaded: false,
    error: "",
  });
  const latest = useRef({ scope, enabled, loader, merge });
  latest.current = { scope, enabled, loader, merge };
  const request = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);

  async function load(after: string | null) {
    const current = latest.current;
    if (!current.enabled || busy.current) return;
    busy.current = true;
    const id = ++request.current;
    setState((previous) => ({
      scope: current.scope,
      items: after && previous.scope === current.scope ? previous.items : [],
      cursor: after,
      loading: true,
      loaded: !!after,
      error: "",
    }));
    const active = () =>
      mounted.current &&
      id === request.current &&
      latest.current.enabled &&
      current.scope === latest.current.scope;
    try {
      const page = await current.loader(after);
      if (!active()) return;
      setState((previous) => ({
        scope: current.scope,
        items: current.merge([...(after ? previous.items : []), ...page.items]),
        cursor: page.nextCursor,
        loading: false,
        loaded: true,
        error: "",
      }));
    } catch (error) {
      if (active())
        setState((previous) => ({
          ...previous,
          loading: false,
          error:
            error instanceof Error ? error.message : "Chargement impossible.",
        }));
    } finally {
      if (id === request.current) busy.current = false;
    }
  }

  useEffect(() => {
    mounted.current = true;
    busy.current = false;
    if (enabled) void load(null);
    return () => {
      request.current += 1;
      busy.current = false;
      mounted.current = false;
    };
  }, [scope, enabled]);

  const visible = enabled && state.scope === scope;
  return {
    items: visible ? state.items : [],
    cursor: visible ? state.cursor : null,
    loading: enabled && (!visible || state.loading),
    loaded: visible && state.loaded,
    error: visible ? state.error : "",
    more: () => {
      if (visible && state.cursor) void load(state.cursor);
    },
    retry: () => {
      if (visible) void load(state.loaded ? state.cursor : null);
    },
  };
}
