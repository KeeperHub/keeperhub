import { Bot } from "lucide-react";

export function LucidIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <Bot className={`${className}`} strokeWidth={1.5} style={style} />;
}
