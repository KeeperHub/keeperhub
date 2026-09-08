# Spec: Struct/Tuple Parameter Support for Protocol Step Handlers

## Context

Protocol step handlers (`protocol-read.ts`, `protocol-write.ts`) flatten all action inputs into a string array and spread them as `...args` to ethers.js. This works for functions with individual parameters (e.g., `balanceOf(address)`) but breaks for Solidity functions that take struct parameters (e.g., Uniswap's `exactInputSingle(ExactInputSingleParams)`), because ethers.js expects a single tuple argument for those.

This blocks adding swap and quote actions to the Uniswap protocol plugin and will affect any future protocol with struct-based function signatures.

## Approach

Create a utility function `reshapeArgsForAbi()` that inspects the ABI function entry and restructures the flat args array to match what ethers.js expects. Integrate it into both core handler files at the point where args are already parsed but before they're passed to ethers.js.

### Algorithm

```
For each ABI function input parameter:
  - If type is "tuple" with components:
    consume N flat args (N = components.length)
    build { componentName: value } object
  - Otherwise:
    consume 1 flat arg as-is
Return reshaped args array
```

For `balanceOf(address owner)`: ABI has 1 simple input -> args stay `["0xAddr"]` (unchanged).
For `exactInputSingle(tuple params)`: ABI has 1 tuple input with 7 components -> 7 flat args become `[{tokenIn: "0x...", tokenOut: "0x...", ...}]`.

## Files

### Create

1. **`keeperhub/lib/abi-struct-args.ts`** -- `reshapeArgsForAbi()` utility
   - Takes: `args: unknown[]`, `functionAbi: { inputs: AbiInput[] }`
   - Returns: `unknown[]` with tuple args wrapped into objects
   - Pure function, no side effects, no imports beyond types

2. **`tests/unit/abi-struct-args.test.ts`** -- Unit tests
   - Simple params (no change)
   - Single tuple param (7 flat args -> 1 object)
   - Empty args
   - Mixed tuple + simple params

### Modify

3. **`keeperhub/plugins/web3/steps/read-contract-core.ts`** (line ~183, after arg filtering)
   - Import `reshapeArgsForAbi`
   - Call `args = reshapeArgsForAbi(args, functionAbi)` before `contract[abiFunction](...args)`

4. **`keeperhub/plugins/web3/steps/write-contract-core.ts`** (line ~143, after arg filtering)
   - Import `reshapeArgsForAbi`
   - Call `args = reshapeArgsForAbi(args, functionAbi)` before gas estimation and contract call

5. **`keeperhub/protocols/uniswap.ts`** -- Add struct-based actions
   - `swap-exact-input` (write) -- SwapRouter02.exactInputSingle
   - `swap-exact-output` (write) -- SwapRouter02.exactOutputSingle
   - `quote-exact-input` (read) -- QuoterV2.quoteExactInputSingle
   - `quote-exact-output` (read) -- QuoterV2.quoteExactOutputSingle
   - Add `swapRouter` and `quoter` contracts

6. **`tests/unit/protocol-uniswap.test.ts`** -- Update action/contract counts

## Verification

1. `pnpm vitest run tests/unit/abi-struct-args.test.ts` -- new utility tests pass
2. `pnpm vitest run tests/unit/protocol-uniswap.test.ts` -- updated protocol tests pass
3. `pnpm check` -- lint clean
4. `pnpm type-check` -- no TypeScript errors
5. Existing protocols (WETH, Sky, etc.) unaffected -- reshapeArgsForAbi is transparent for simple params
