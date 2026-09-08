import { ethers } from "ethers";
import artifact from "./event-emitter.artifact.json" with { type: "json" };

export interface DeployedFixture {
  address: string;
  abi: unknown[];
  contract: ethers.Contract;
}

export async function deployEventEmitter(
  wallet: ethers.Wallet,
): Promise<DeployedFixture> {
  const factory = new ethers.ContractFactory(
    artifact.abi as ethers.InterfaceAbi,
    artifact.bytecode,
    wallet,
  );
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  return {
    address,
    abi: artifact.abi as unknown[],
    contract: deployed as ethers.Contract,
  };
}
