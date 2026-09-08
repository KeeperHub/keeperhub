import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { programsInvoked } from "@/lib/policy/solana-programs";

const PAYER = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function serialize(tx: Transaction): Uint8Array {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

describe("reading the programs out of a Solana transaction", () => {
  it("finds the program a single instruction invokes", () => {
    const tx = new Transaction({
      feePayer: PAYER,
      recentBlockhash: BLOCKHASH,
    }).add(
      SystemProgram.transfer({
        fromPubkey: PAYER,
        toPubkey: PAYER,
        lamports: 1,
      })
    );
    expect(programsInvoked(serialize(tx))).toContain(
      SystemProgram.programId.toBase58()
    );
  });

  it("finds every program in a multi-instruction transaction", () => {
    // One denied instruction is enough to refuse the whole transaction: they
    // are signed together and they land together.
    const tx = new Transaction({
      feePayer: PAYER,
      recentBlockhash: BLOCKHASH,
    })
      .add(
        SystemProgram.transfer({
          fromPubkey: PAYER,
          toPubkey: PAYER,
          lamports: 1,
        })
      )
      .add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO,
          data: Buffer.from("hello"),
        })
      );

    const programs = programsInvoked(serialize(tx));
    expect(programs).toContain(SystemProgram.programId.toBase58());
    expect(programs).toContain(MEMO.toBase58());
  });

  it("preserves base58 case, which is part of the key", () => {
    const tx = new Transaction({
      feePayer: PAYER,
      recentBlockhash: BLOCKHASH,
    }).add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO,
        data: Buffer.from(""),
      })
    );
    // Lowercasing a base58 address does not fail, it decodes to a different and
    // still valid key, so a rule would be about a program nobody named.
    expect(programsInvoked(serialize(tx))).toContain(
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
    );
  });

  it.each([
    ["empty bytes", new Uint8Array()],
    ["random bytes", new Uint8Array([1, 2, 3, 4, 5])],
  ])("reports nothing for %s, so the caller can refuse", (_name, bytes) => {
    expect(programsInvoked(bytes)).toEqual([]);
  });
});
