// Brand mark: rounded square with a cobalt→teal gradient and a ring glyph.
// `size` drives the square; the ring scales with it.

export function BrandMark({ size = 34 }: { size?: number }) {
  const ring = Math.round(size * 0.32);
  return (
    <div
      className="flex items-center justify-center rounded-[10px] shadow-[var(--shadow-sm)]"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, var(--primary), var(--teal))",
      }}
      aria-hidden="true"
    >
      <div
        className="rounded-full"
        style={{
          width: ring,
          height: ring,
          border: `${Math.max(2, size * 0.075)}px solid #fff`,
        }}
      />
    </div>
  );
}
