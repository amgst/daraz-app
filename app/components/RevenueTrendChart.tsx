import { useRef, useState } from "react";

interface Point {
  date: string;
  value: number;
}

interface Props {
  data: Point[];
  currency: string | null;
}

const WIDTH = 640;
const HEIGHT = 200;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const INNER_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const INNER_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

function formatMoney(n: number, currency: string | null) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}${currency ? ` ${currency}` : ""}`;
}

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Single-series time trend - no legend needed (the card title names the
// series), so this only needs one accessible-hue line + area fill, not a
// categorical palette. Screen reader users get the total via the visually
// hidden summary rather than a full data table, to keep this a lightweight
// dashboard widget rather than a full analytics page.
export default function RevenueTrendChart({ data, currency }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (data.length === 0) {
    return null;
  }

  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const points = data.map((d, i) => {
    const x = PAD_LEFT + (data.length === 1 ? 0 : (i / (data.length - 1)) * INNER_WIDTH);
    const y = PAD_TOP + INNER_HEIGHT - (d.value / maxValue) * INNER_HEIGHT;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const baselineY = PAD_TOP + INNER_HEIGHT;
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${baselineY} L ${points[0].x.toFixed(2)} ${baselineY} Z`;

  const total = data.reduce((sum, d) => sum + d.value, 0);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - x);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  };

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        Revenue over the last {data.length} days totals {formatMoney(total, currency)}.
      </span>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
        aria-hidden="true"
      >
        {[0, 0.5, 1].map((g) => {
          const y = PAD_TOP + INNER_HEIGHT * (1 - g);
          return (
            <line
              key={g}
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y}
              y2={y}
              stroke="var(--p-color-border-secondary)"
              strokeWidth={1}
            />
          );
        })}
        <path d={areaPath} fill="var(--p-color-bg-fill-info)" fillOpacity={0.12} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--p-color-bg-fill-info)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hovered && (
          <>
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={PAD_TOP}
              y2={baselineY}
              stroke="var(--p-color-border)"
              strokeWidth={1}
            />
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={4}
              fill="var(--p-color-bg-fill-info)"
              stroke="var(--p-color-bg-surface)"
              strokeWidth={2}
            />
          </>
        )}
        <text x={PAD_LEFT} y={HEIGHT - 6} fontSize={11} fill="var(--p-color-text-secondary)">
          {formatDateLabel(data[0].date)}
        </text>
        <text
          x={WIDTH - PAD_RIGHT}
          y={HEIGHT - 6}
          fontSize={11}
          fill="var(--p-color-text-secondary)"
          textAnchor="end"
        >
          {formatDateLabel(data[data.length - 1].date)}
        </text>
      </svg>
      {hovered && (
        <div
          style={{
            position: "absolute",
            left: `${(hovered.x / WIDTH) * 100}%`,
            top: 0,
            transform: "translate(-50%, -100%)",
            background: "var(--p-color-bg-surface-inverse)",
            color: "var(--p-color-text-inverse)",
            padding: "4px 8px",
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {formatDateLabel(hovered.date)}: {formatMoney(hovered.value, currency)}
        </div>
      )}
    </div>
  );
}
