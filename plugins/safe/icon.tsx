import { ShieldCheck } from "lucide-react";

export function SafeIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ShieldCheck className={`${className}`} strokeWidth={1.5} style={style} />
  );
}
