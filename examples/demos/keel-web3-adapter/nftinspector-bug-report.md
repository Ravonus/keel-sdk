# NFT Inspector: web3:// media analyzes correctly but preview falls back to a raw `web3://` iframe src

**TL;DR:** Your analyzer resolves `web3://` media perfectly, but the preview only renders it on the
POST `/api/app/nft/load` path. The SSE (`load-events`) and cached (`hydrate-media`) paths redact
`resolved_data_uri` to a `data:<mime>;sha256=<hash>` stub, and the media component then falls back
to the raw `web3://` URL as `<iframe src>` / `<img src>` — a scheme browsers can't load — so the
preview shows a blank white frame even though your backend already has the payload.

## Test case (Sepolia, live)

https://nftinspector.xyz/11155111/0x87c96dc8b411da0cf5b1248b2c8b522ddaccbd66/5

Token #5's tokenURI, image, and animation_url are all pure auto-mode `web3://` URLs
(`web3://0x417cfdf69ed808b7e6e6c5d974c27bb8ccffbec5:11155111/haulObject/<bytes32>?mime.type=...`).
The target contract is Sourcify-verified. Your analysis grades it 83/100 "Onchain Immutable" and
every component badge shows `web3 -> data` Onchain — resolution works end to end.

## Repro

1. Open the token page → Preview tab → white frame.
2. Inspect the DOM: `<iframe sandbox="allow-scripts" src="web3://0x417c...">` — raw scheme, no srcdoc.
3. From the console: `POST /api/app/nft/load` with `forceRefresh: true` returns the **full**
   `resolved_data_uri` (`data:text/html;charset=utf-8,%3C!doctype...`, ~39 KB), while
   `POST /api/app/nft/hydrate-media` for the same token returns the redacted 86-char sha256 stub.
4. Forcing the SSE path to fail (so the UI falls back to the POST load) and clicking Reinspect makes
   the same token render immediately — animation plays. Nothing on-chain changed between the white
   and the working render.

## Suggested fix (either works)

- Serve the resolved payload (or an asset-store URL for it) through `load-events`/`hydrate-media`
  instead of only the sha256 stub — the asset ids are already in the response; or
- In the media component, never fall back to a raw `web3://`/`w3://` URL for `iframe`/`img` src —
  browsers can't load the scheme. Re-resolve via your backend or an ERC-6944 gateway
  (`https://<contract>.<chain>.w3link.io/<path>`) instead.

Happy to provide more test tokens (the same collection has gateway-URL and data:-URI variants for
comparison: tokens 2, 3, and the sibling contracts 0xbce62004... and 0x24931891...).
