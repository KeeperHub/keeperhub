import { ethers } from "ethers";
import fs from "fs";
const pairs = JSON.parse(fs.readFileSync("/tmp/pairs.json","utf8"));
const RPC = {
  "1":"https://ethereum-rpc.publicnode.com","10":"https://mainnet.optimism.io",
  "56":"https://bsc-dataseed.binance.org","97":"https://bsc-testnet-rpc.publicnode.com",
  "100":"https://rpc.gnosischain.com","137":"https://polygon-bor-rpc.publicnode.com",
  "8453":"https://mainnet.base.org","42161":"https://arb1.arbitrum.io/rpc",
  "43113":"https://api.avax-test.network/ext/bc/C/rpc","43114":"https://api.avax.network/ext/bc/C/rpc",
  "80002":"https://rpc-amoy.polygon.technology","84532":"https://sepolia.base.org",
  "421614":"https://sepolia-rollup.arbitrum.io/rpc","11155111":"https://ethereum-sepolia-rpc.publicnode.com",
};
const provs={}; for(const [c,u] of Object.entries(RPC)) provs[c]=new ethers.JsonRpcProvider(u,undefined,{staticNetwork:true});
const empty=[], errs=[];
const groups={}; pairs.forEach(p=>(groups[p.chain] ||= []).push(p));
for(const [chain,list] of Object.entries(groups)){
  const p=provs[chain]; if(!p){console.log(`no RPC for chain ${chain}`);continue;}
  for(let i=0;i<list.length;i+=6){
    const batch=list.slice(i,i+6);
    await Promise.all(batch.map(async t=>{
      try{ const code=await p.getCode(t.addr);
        if(code==="0x") empty.push(t);
      }catch(e){ errs.push({...t,e:(e.shortMessage||e.message||"").slice(0,40)}); }
    }));
  }
  process.stderr.write(`chain ${chain} done (${list.length})\n`);
}
console.log("\n=== DECLARED ADDRESSES WITH NO BYTECODE ===");
if(!empty.length) console.log("  none");
empty.forEach(t=>console.log(`  ${t.proto}/${t.contract} chain ${t.chain}: ${t.addr}`));
console.log("\n=== RPC ERRORS (inconclusive) ===", errs.length);
const ec={}; errs.forEach(e=>ec[e.chain]=(ec[e.chain]||0)+1); console.log(" ",JSON.stringify(ec));
