import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";

// web3Connection of a copied step whose Safe the new organization does not own:
// the step has no sender until one is picked, and never falls back to another.
export const SENDER_NOT_CHOSEN = "needs-sender";

export const SENDER_NOT_CHOSEN_MESSAGE =
  "No sender chosen for this step. Open the step and pick one under Web3 Connection.";

export class SenderNotChosenError extends Error {
  constructor() {
    super(SENDER_NOT_CHOSEN_MESSAGE);
    this.name = "SenderNotChosenError";
  }
}

type Web3ConnectionFailure = {
  success: false;
  error: string;
  errorClass?: ExecutionErrorType;
};

/** The refusal of a step that has no sender: the author's to fix. */
export function senderNotChosenFailure(): Web3ConnectionFailure & {
  errorClass: ExecutionErrorType;
} {
  return {
    success: false,
    error: SENDER_NOT_CHOSEN_MESSAGE,
    errorClass: ExecutionErrorType.USER,
  };
}

/**
 * A step's failure when its Web3 Connection cannot be resolved. A missing
 * sender is USER; other failures get `classOf`'s class, or none.
 */
export function web3ConnectionFailure(
  error: unknown,
  classOf?: (message: string) => ExecutionErrorType
): Web3ConnectionFailure {
  // Matched by name too, in case the error crossed a module copy.
  if (
    error instanceof SenderNotChosenError ||
    (error instanceof Error && error.name === "SenderNotChosenError")
  ) {
    return senderNotChosenFailure();
  }
  const message = `Failed to resolve Web3 Connection: ${getErrorMessage(error)}`;
  return classOf
    ? { success: false, error: message, errorClass: classOf(message) }
    : { success: false, error: message };
}
