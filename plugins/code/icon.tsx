import { Code } from "lucide-react";

export function CodeIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement {
  return <Code className={className} strokeWidth={1.5} style={style} />;
}
