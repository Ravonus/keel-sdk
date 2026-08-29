import assert from "node:assert/strict";
import test from "node:test";

import { decodeFunctionResult, encodeFunctionResult, parseAbi } from "viem";

import {
  oneMintControllerAbi,
  oneMintCoreDropReadAbi,
} from "../packages/sdk/dist/index.js";

const creator = "0x764E3EE7A844d9165937c41fd08086e43b997149";
const target = "0x89353d6847EcAb3c5E2d2b89d0401ddc3b0250Ef";
const digest = "0xee594f9f8106382885d65d35bf84a189847412529099518057946f430f48bf89";
const coreAbi = parseAbi(oneMintCoreDropReadAbi);
const currentAbi = parseAbi(oneMintControllerAbi);

const coreDrop = {
  creator,
  target,
  payout: creator,
  supply: 1n,
  minted: 0n,
  defaultMaxPerTransaction: 1,
  defaultMaxPerWallet: 1,
  stageCount: 1,
  paused: false,
  closed: false,
  capacityReserved: true,
  exists: true,
  metadataDigest: digest,
};

test("stable OneMint drop ABI decodes the deployed 13-word Sepolia layout", () => {
  const data = encodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    result: coreDrop,
  });

  assert.equal((data.length - 2) / 2, 416);
  assert.deepEqual(decodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    data,
  }), coreDrop);
});

test("stable OneMint drop ABI ignores appended item fields on current controllers", () => {
  const data = encodeFunctionResult({
    abi: currentAbi,
    functionName: "getDrop",
    result: {
      ...coreDrop,
      targetTokenId: 22n,
      itemized: true,
    },
  });

  assert.equal((data.length - 2) / 2, 480);
  assert.deepEqual(decodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    data,
  }), coreDrop);
});
