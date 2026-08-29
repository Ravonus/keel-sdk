# Immutable Three.js 1/1 publication harness

This container is an offline, review-only proof of the KEEL publication path.
It declares every required module, builds one closed Three.js scene, selects the
smallest supported compression, plans 23,000-byte native KEEL carrier chunks in
groups of at most three, creates an unsigned EIP-5792 request, and resolves the
result through the default strict KEEL viewer and sandbox.

It does not sign, submit, spend ETH, or pretend that its fixture collection
address is the live predicted address. A public batch must first replace the
fixture owner and collection with a fresh read-only factory nonce/prediction.

```sh
docker build -f examples/immutable-three-one-of-one/Dockerfile -t keel-three-one-of-one .
docker run --rm keel-three-one-of-one
```
