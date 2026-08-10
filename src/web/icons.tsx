import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function PlayIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" /></svg>;
}

export function ShieldIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 3 5 6v5c0 4.8 2.8 8.1 7 10 4.2-1.9 7-5.2 7-10V6Z" /><path d="m9 12 2 2 4-5" /></svg>;
}

export function SearchIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
}

export function RefreshIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 11.9-2" /></svg>;
}

export function CheckIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>;
}

export function ExternalIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M14 5h5v5" /><path d="m12 12 7-7" /><path d="M19 14v5H5V5h5" /></svg>;
}
