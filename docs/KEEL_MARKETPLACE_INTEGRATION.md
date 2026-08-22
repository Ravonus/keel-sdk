# Keel Marketplace Integration

## Minimum integration

1. Resolve the token's committed Keel manifest.
2. Resolve resources through declared native, OnchFS, IPFS, or HTTPS carriers.
3. Verify decoded SHA-256 and length before caching or rendering.
4. Install the open-source `keel-marketplace-api@1` host API.
5. Mount HTML in the normal Keel sandbox or render a verified media resource.

Marketplaces do not need to execute the artwork to render a cover or optimized
display image. They can call `verifyMedia` against committed derivative receipts.

Plain browser code can install the immutable global:

```js
import { createKeelMarketplaceApi, installKeelMarketplaceGlobal } from "@keel/viewer";

const api = createKeelMarketplaceApi(resolvedArtifact);
installKeelMarketplaceGlobal(api);
const proof = await globalThis.Keel.verifyMedia({
  sourceResourceId: "cover",
  candidate: optimizedWebp,
  profile: "display-webp-1024-v1",
});
```

React uses the same object; no special renderer or iframe is required:

```tsx
const [proof, setProof] = useState();
useEffect(() => {
  void api.verifyMedia({ sourceResourceId: "cover", candidate: webp }).then(setProof);
}, [api, webp]);
const resource = proof?.status === "verified-derivative"
  ? proof.derivative.outputResourceId
  : "cover";
return <img src={api.resolve(resource).url()} />;
```

The artifact iframe receives only `globalThis.__KEEL__`, which exposes its
already resolved manifest resources and no arbitrary network capability.

## Verification labels

- **Exact:** bytes are the canonical source object.
- **Verified derivative:** bytes match a committed derivative output.
- **Unverified:** bytes were changed by an unknown optimizer.

Never label perceptual similarity as cryptographic verification.

## Hosting

The reference proxy and SDK are open source. A marketplace may run them itself,
use several independent instances, or read supported objects directly. A proxy
cannot substitute content because every accepted response is checked against
the chain-committed digest.

On Tezos, the unified Keel store exposes the standard OnchFS file views over
the same physical chunks. A custom deployment must be identified with its full
OnchFS authority (network and contract) unless a marketplace has registered it
as a default. Marketplaces that do not yet recognize that authority can use the
open resolver or the verified IPFS directory; neither changes the canonical
Keel identities.

Studio's OnchFS export is a signed-off carrier plan rather than another media
package. `keel-onchfs.json` contains the exact standard inscriptions and the
Keel bindings for the same chunks. A marketplace or creator-run publisher
may submit that plan, then use the committed full-authority root URI. The plan
is offered only after Studio validates the artifact against a pinned measured
read profile for that exact contract.

## ZIP compatibility

If a marketplace requires a ZIP upload, Studio may generate it from the already
verified directory. The ZIP must contain the same root `index.html` and relative
module paths. It is a disposable delivery artifact, not canonical storage.
