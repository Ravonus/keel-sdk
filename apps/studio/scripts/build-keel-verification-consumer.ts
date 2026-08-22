#!/usr/bin/env node

import path from "node:path";

import { buildKeelVerificationConsumerFixtures } from "./keel-verification-consumer-fixtures";

const repositoryRoot=path.resolve(import.meta.dirname,"../../..");
const outputDirectory=path.resolve(process.env.KEEL_VERIFICATION_CONSUMER_OUTPUT??path.join(repositoryRoot,"packages/tezos/build/keel-verification-consumer"));
const result=await buildKeelVerificationConsumerFixtures({repositoryRoot,outputDirectory});
process.stdout.write(`${JSON.stringify({status:"PASS",outputDirectory,cases:result.cases.length,receipts:result.receipts})}\n`);
