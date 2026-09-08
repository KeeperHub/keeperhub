import {
  NodeDescription,
  NodeTitle,
} from "@/components/ai-elements/node";

type NodeLabelProps = {
  title: string;
  description?: string;
};

export const NodeLabel = ({ title, description }: NodeLabelProps) => (
  <div className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
    <NodeTitle className="line-clamp-2 w-full break-words text-base">
      {title}
    </NodeTitle>
    {description && (
      <NodeDescription className="line-clamp-2 w-full break-words text-xs">
        {description}
      </NodeDescription>
    )}
  </div>
);
