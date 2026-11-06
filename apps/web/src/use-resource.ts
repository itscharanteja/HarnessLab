"use client";

import { useEffect, useState } from "react";
import { RequestError } from "./api";

export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  repeat?: (value: T) => boolean,
): { value?: T; error?: string } {
  const [state, setState] = useState<{
    key: string;
    load: typeof load;
    value?: T;
    error?: string;
  }>({ key, load });
  useEffect(() => {
    const controller = new AbortController();
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try {
        const value = await load(controller.signal);
        if (controller.signal.aborted) return;
        setState({ key, load, value });
        delay = 2000;
        if (repeat?.(value)) timer = setTimeout(update, delay);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((prior) => ({
          key,
          load,
          value:
            prior.key === key && prior.load === load ? prior.value : undefined,
          error:
            error instanceof Error ? error.message : "Unable to load data.",
        }));
        if (
          repeat &&
          (!(error instanceof RequestError) || error.status >= 500)
        ) {
          delay = Math.min(delay * 2, 15000);
          timer = setTimeout(update, delay);
        }
      }
    }
    void update();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, load, repeat]);
  return state.key === key && state.load === load ? state : {};
}
