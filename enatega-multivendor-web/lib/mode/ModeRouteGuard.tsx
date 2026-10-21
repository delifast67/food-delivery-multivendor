"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isRouteCompatible } from "./routes";
import { modeStorage } from "./storage";

export default function ModeRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (!isRouteCompatible(pathname)) {
      router.replace("/delifast");
      return;
    }
    const pending = modeStorage.get("pendingOrderNavigation");
    if (!pending) return;
    modeStorage.remove("pendingOrderNavigation");
    if (pending.startsWith("/") && !pending.startsWith("//")) router.push(pending);
  }, [pathname, router]);
  return isRouteCompatible(pathname) ? children : null;
}
