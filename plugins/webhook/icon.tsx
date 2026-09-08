import { Webhook } from "lucide-react";

export function WebhookIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <Webhook className={`${className}`} strokeWidth={1.5} style={style} />;
}
