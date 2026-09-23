export interface SubmitResult {
  topicId: string;
  sequenceNumber: string;
  consensusTimestamp: string;
  hashscanLink: string;
}

export interface VerifyResult {
  verified: boolean;
  payload: string;
  sequenceNumber: string;
  consensusTimestamp: string;
}
