// Brand mark — "Orbit": a clock face on a navy tile with a mint dot orbiting
// it (the repeating pay periods). Same artwork as public/icon.svg; the tile is
// dark in both themes so it reads the same everywhere.

export function BrandMark({ size = 34 }: { size?: number }) {
  // Thicker strokes at small sizes so the glyph survives a 16–24px render.
  const sw = size <= 24 ? 3.8 : 3.2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      className="flex-none"
    >
      <rect width="48" height="48" rx="11" fill="#0d1b2e" />
      <circle cx="24" cy="24" r="12" fill="none" stroke="#79a3ff" strokeWidth={sw} />
      <path
        d="M24 17v7l5 3"
        fill="none"
        stroke="#fff"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32.5" cy="15.5" r="4.8" fill="#43e3a8" stroke="#0d1b2e" strokeWidth="1.6" />
    </svg>
  );
}
