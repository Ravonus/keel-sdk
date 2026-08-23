# Verified Content Gateway

The content gateway is the main security and usability boundary between arbitrary artifact code and storage infrastructure.

## Core rule

> Creator code may name declared content, but it may not retrieve arbitrary content.

A resource can be stored on Ethereum, IPFS, Arweave, a creator server, a CDN, or several ordered fallbacks. The host obtains the bytes and verifies the manifest-declared digest first. Only then is the resource made visible to the artifact.

## Commitment chain

```text
KeelIndex
  activePresentation(collection, tokenId)
        ↓
manifest URI + SHA-256 digest + revision
        ↓
RFC 8785 manifest verification
        ↓
resource source + decoded-byte digest
        ↓
host retrieval / contract read / object reconstruction
        ↓
verified resource
        ↓
virtual route
```

A creator-controlled server can replace its file, disappear, or return malicious bytes. The replacement is rejected unless it matches the committed digest. A different mirror may then satisfy the same resource.

## Routes

For a resource with ID `hero-model`, the gateway automatically exposes:

```text
keel://hero-model
/content/hero-model
/content/<manifest-id>/hero-model
```

It may also expose:

```text
/ipfs/<cid>/<path>
/onchain/<chain-id>/<store-address>/<object-id>
eip155:<chain-id>:<store-address>/object/<object-id>
<exact declared source URI>
<exact accepted retrieval location>
<custom manifest alias>
```

Aliases are exact, collision-checked, and manifest-scoped. They do not act as prefixes or wildcards.

## External HTTPS and IPFS are allowed

A manifest can declare:

```json
{
  "kind": "uri",
  "uri": "https://artist.example/assets/scene.glb",
  "integrity": {
    "algorithm": "sha256",
    "digest": "0x...",
    "byteLength": 1804123
  }
}
```

The artifact may still use that exact URL in its own code. The sandbox intercepts the request and returns the already verified local bytes. It does not contact `artist.example` from the creator iframe.

The same applies to `ipfs://...`: the trusted host selects a gateway, verifies the decoded bytes, and mounts them under the exact IPFS name and `/ipfs/` route.

## On-chain routes

An on-chain resource declares chain, `KeelHold`, object ID, compression, and decoded-byte digest. The host adapter reads the object tree and verifies every node. The creator iframe receives a local response for `/onchain/...`; it receives no RPC endpoint, provider, or wallet.

Contract-call resources work similarly. The exact return value is decoded and hash-checked before exposure.

## Host retrieval policy

The resolver provides several independent controls:

- HTTPS-only remote retrieval by default;
- IPFS/IPNS/Arweave gateway expansion;
- optional host/path `sourceAllowlist`;
- private, loopback, link-local, `.local`, and literal metadata-network denial;
- credentials in URLs rejected;
- automatic redirects disabled;
- optional `authorizeRemoteSource(url, signal)` hook.

Use `authorizeRemoteSource` in server/Electron hosts to resolve DNS and reject private/reserved addresses, apply outbound firewall policy, require certificate pins, or enforce organization-specific rules. String hostname checks alone cannot eliminate DNS rebinding or compromised DNS.

## Runtime behavior

### Static references

HTML, CSS, JavaScript, SVG, JSON, XML, and related text resources are scanned recursively. Declared aliases are replaced with verified data URLs. Cycles and depth are reported.

### Dynamic references

The sandbox exposes:

```js
await fetch("/content/hero-model")
__KEEL_CONTENT__.bytes("hero-model")
__KEEL_CONTENT__.text("/content/config")
__KEEL_CONTENT__.json("keel://metadata")
__KEEL_CONTENT__.url("ipfs://...")
```

Only GET and HEAD are supported. Undeclared names receive a blocked response or `SecurityError`.

The gateway also hardens XHR and common DOM URL properties/attributes. Raw WebSocket, EventSource, Worker, SharedWorker, beacon, forms, ordinary anchor navigation, and window opening are denied. The mounted iframe additionally receives the same policy through the experimental `csp` attribute where supported and is marked `credentialless`.

## Browser sandbox versus host firewall

The iframe uses an opaque origin and a restrictive CSP, and the bootstrap intercepts known browser request/navigation surfaces. That is strong defense in depth, but no JavaScript shim can guarantee that every current or future browser feature has no network side channel.

For high assurance:

- Web: use a dedicated origin plus browser/process/network policy and monitor outbound traffic.
- Electron: use a dedicated session and install `installElectronViewerEgressGuard(session)`; it cancels all renderer requests below creator JavaScript.
- Kiosk/native: use an operating-system or container egress firewall around the renderer.

Host-verified retrieval should happen outside that isolated renderer, after which only verified bytes are handed in.

## Service-worker or server route integration

`createVerifiedContentGateway()` is framework-neutral. `createVerifiedContentFetchHandler()` directly maps the gateway to standard Fetch API `Request`/`Response` objects without ever delegating to public `fetch`. A host can use either adapter for:

- a service-worker response for trusted app code;
- a Next.js/Node route;
- an Electron custom protocol;
- an offline bundle;
- a test harness.

```ts
const handle = createVerifiedContentFetchHandler(artifact);

// Service worker, Next.js route, Cloudflare Worker, or another Fetch-style host:
return handle(request);
```

Do not make the route globally addressable by artifact ID without binding it to the already verified manifest/revision. Route tables should be per resolved artifact or keyed by an unguessable viewer session.
