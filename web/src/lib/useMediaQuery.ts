import { useEffect, useState } from "react";

/** Live `matchMedia` result. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The app's single layout breakpoint (Tailwind `min-[900px]:`). */
export const useIsMobile = () => useMediaQuery("(max-width: 899.98px)");
