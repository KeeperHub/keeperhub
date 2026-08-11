/**
 * Pure interface definitions for the deterministic workflow factory.
 *
 * IMPORTANT: This file must NOT import "server-only". Phase 53 client
 * components import PrefillWorkflow for canvas preview rendering; a transitive
 * server-only import would crash the client build.
 */
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

/**
 * A pre-built workflow returned by the factory, ready to be previewed on the
 * canvas (Phase 53) and saved via the workflow save flow (Phase 54).
 *
 * All Phase 52 factory shapes are read-only monitor workflows (PREFILL-06).
 * The `workflowType` literal ensures downstream guards treat it correctly.
 */
export interface PrefillWorkflow {
  /** Canvas nodes conforming to the WorkflowNode shape from lib/workflow/store. */
  nodes: WorkflowNode[];
  /** Canvas edges conforming to the WorkflowEdge shape from lib/workflow/store. */
  edges: WorkflowEdge[];
  /**
   * Always "read" for Phase 52 factory output.
   * Passes the existing runWriteActionCheck guard with no warnings.
   */
  workflowType: "read";
  /** Suggested workflow name for the Phase 53 save dialog. */
  name: string;
  /** From SuggestionDescriptor.description — shown in the Phase 53 save dialog. */
  description: string;
}
