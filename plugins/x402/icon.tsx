import { CircleDollarSign } from "lucide-react";

export function X402Icon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <CircleDollarSign className={`${className}`} strokeWidth={1.5} style={style} />
  );
}
