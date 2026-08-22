# Keel metadata resolver compatibility

A legacy metadata contract only needs to expose raw JSON:

```solidity
function tokenJSON(uint256 tokenId) external view returns (string memory);
```

That function is already a valid ERC-4804 endpoint. The direct route is:

```text
web3://<contract>:<chainId>/tokenJSON/<tokenId>
```

The SDK helper `keelTokenJSONURI` builds this route without introducing a
gateway or HTTP mirror.

When older wallets or marketplaces need the conventional ERC-721 metadata
URI, deploy `KeelSleeve` with the legacy contract as `source`.
It reads the legacy JSON unchanged, exposes the same `tokenJSON` endpoint,
returns `data:application/json;base64,<raw-json>` from `tokenURI`, and reports
its own ERC-4804 route from `erc4804URI`.

```solidity
KeelSleeve adapter = new KeelSleeve(address(legacy));

adapter.tokenURI(1);    // data:application/json;base64,...
adapter.erc4804URI(1);  // web3://<adapter>:<chainId>/tokenJSON/1
```

The adapter is read-only and does not claim ownership, minting authority, or
ERC-721 identity for the legacy source. It is only the compatibility boundary
between raw JSON, ERC-4804, and the older `tokenURI` presentation.
