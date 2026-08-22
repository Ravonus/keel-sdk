import smartpy as sp

from contracts.keel_presentation_state import (
    keel_presentation_state_module,
    keel_presentation_state_types,
)
from contracts.keel_immutable_checkpoint import (
    keel_immutable_checkpoint_module,
    keel_immutable_checkpoint_types,
)
from contracts.keel_onchfs_store import (
    keel_onchfs_store_module,
    keel_onchfs_types,
)


def raw(value: str) -> sp.Expr:
    return sp.bytes("0x" + value.encode().hex())


def policy_id(creator: sp.Expr, salt: str) -> sp.Expr:
    return sp.sha256(sp.pack(sp.record(creator=creator, salt=raw(salt))))


@sp.module
def presentation_test_token_module():
    balance_request: type = sp.record(owner=sp.address, token_id=sp.nat).layout(
        ("owner", "token_id")
    )

    class PresentationTestToken(sp.Contract):
        def __init__(self, administrator, owner):
            self.data.administrator = administrator
            self.data.ledger = sp.cast(
                sp.big_map({7: owner}), sp.big_map[sp.nat, sp.address]
            )

        @sp.entrypoint
        def set_owner(self, params):
            sp.cast(params, sp.record(token_id=sp.nat, owner=sp.address))
            assert sp.sender == self.data.administrator, "NOT_ADMIN"
            self.data.ledger[params.token_id] = params.owner

        @sp.onchain_view()
        def get_balance(self, request):
            sp.cast(request, balance_request)
            return (
                sp.nat(1)
                if self.data.ledger.get(request.token_id, default=self.data.administrator)
                == request.owner
                else sp.nat(0)
            )


@sp.module
def presentation_staking_adapter_module():
    stake_request: type = sp.record(collection=sp.address, token_id=sp.nat).layout(
        ("collection", "token_id")
    )
    stake_state: type = sp.record(staked=sp.bool, controller=sp.address).layout(
        ("staked", "controller")
    )
    set_state: type = sp.record(staked=sp.bool, controller=sp.address).layout(
        ("staked", "controller")
    )

    class PresentationStakingAdapter(sp.Contract):
        def __init__(self, administrator):
            self.data.administrator = administrator
            self.data.staked = False
            self.data.controller = administrator

        @sp.entrypoint
        def set_state(self, params):
            sp.cast(params, set_state)
            assert sp.sender == self.data.administrator, "NOT_ADMIN"
            self.data.staked = params.staked
            self.data.controller = params.controller

        @sp.onchain_view()
        def keel_stake_state(self, request):
            sp.cast(request, stake_request)
            return sp.cast(
                sp.record(staked=self.data.staked, controller=self.data.controller),
                stake_state,
            )

@sp.add_test()
def keel_presentation_state_cross_chain_parity():
    scenario = sp.test_scenario(
        "Keel presentation state Tezos edge matrix",
        [
            keel_presentation_state_types,
            keel_presentation_state_module,
            keel_onchfs_types,
            keel_onchfs_store_module,
            keel_immutable_checkpoint_types,
            keel_immutable_checkpoint_module,
            presentation_test_token_module,
            presentation_staking_adapter_module,
        ],
    )
    creator = sp.test_account("Creator")
    owner = sp.test_account("Owner")
    oracle = sp.test_account("Oracle")
    attacker = sp.test_account("Attacker")
    escrow = sp.test_account("Escrow")
    token = presentation_test_token_module.PresentationTestToken(
        creator.address, owner.address
    )
    registry = keel_presentation_state_module.KeelPresentationStateRegistry()
    store = keel_onchfs_store_module.KeelOnchFSStore(creator.address)
    checkpoints = (
        keel_immutable_checkpoint_module.KeelImmutableCheckpointRegistry()
    )
    staking_adapter = presentation_staking_adapter_module.PresentationStakingAdapter(
        creator.address
    )
    scenario += token
    scenario += staking_adapter
    scenario += registry
    scenario += store
    scenario += checkpoints

    none_address = sp.cast(None, sp.option[sp.address])

    css = policy_id(creator.address, "css")
    registry.create_policy(
        sp.record(
            policy_id=css,
            salt=raw("css"),
            oracle=none_address,
            collection=none_address,
            token_id=0,
            media_type=raw("text/css"),
            max_bytes=64000,
            authority=raw("creator"),
            update_kind=raw("resource-revision"),
            value_kind=raw("binary"),
            executable=False,
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=css,
            expected_parent=0,
            value_digest=sp.sha256(raw("css-v1")),
            byte_length=6,
            media_type=raw("text/css"),
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=css,
            expected_parent=1,
            value_digest=sp.sha256(raw("css-v2")),
            byte_length=6,
            media_type=raw("text/css"),
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=css,
            expected_parent=2,
            value_digest=sp.sha256(raw("attack")),
            byte_length=6,
            media_type=raw("text/css"),
        ),
        _sender=attacker,
        _valid=False,
        _exception="UNAUTHORIZED",
    )
    scenario.verify(
        sp.View(registry, "presentation_matches")(
            sp.record(
                policy_id=css,
                revision=2,
                value_digest=sp.sha256(raw("css-v2")),
                byte_length=6,
                source_manifest_digest=sp.bytes("0x"),
                source_sequence=0,
            )
        )
    )

    materialized = policy_id(creator.address, "materialized-css")
    first = raw("body{")
    second = raw("color:red}")
    first_pointer = sp.keccak(first)
    second_pointer = sp.keccak(second)
    complete = sp.concat([first, second])
    store.write_chunk(first)
    store.write_chunk(second)
    empty_root = sp.bytes(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
    first_root = sp.keccak(
        sp.pack(
            sp.cast(
                sp.record(
                    previous=empty_root,
                    index=0,
                    chunk_pointer=first_pointer,
                    byte_length=5,
                ),
                keel_immutable_checkpoint_types.rolling_step,
            )
        )
    )
    final_root = sp.keccak(
        sp.pack(
            sp.cast(
                sp.record(
                    previous=first_root,
                    index=1,
                    chunk_pointer=second_pointer,
                    byte_length=10,
                ),
                keel_immutable_checkpoint_types.rolling_step,
            )
        )
    )
    immutable_identity = sp.cast(
        sp.record(
            chunk_store=store.address,
            expected_index_root=final_root,
            expected_chunk_count=2,
            expected_stored_sha256=sp.sha256(complete),
            expected_stored_byte_length=15,
            decoded_sha256=sp.sha256(complete),
            decoded_byte_length=15,
            media_type=raw("text/css"),
            compression=raw("none"),
        ),
        keel_immutable_checkpoint_types.identity,
    )
    immutable_object_id = sp.sha256(sp.pack(immutable_identity))
    registry.create_policy(
        sp.record(
            policy_id=materialized,
            salt=raw("materialized-css"),
            oracle=none_address,
            collection=none_address,
            token_id=0,
            media_type=raw("text/css"),
            max_bytes=64000,
            authority=raw("creator"),
            update_kind=raw("resource-revision"),
            value_kind=raw("binary"),
            executable=False,
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=materialized,
            expected_parent=0,
            value_digest=sp.sha256(complete),
            byte_length=15,
            media_type=raw("text/css"),
        ),
        _sender=creator,
    )
    checkpoints.begin_checkpoint(
        sp.record(object_id=immutable_object_id, identity=immutable_identity),
        _sender=creator,
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=immutable_object_id,
            expected_index=0,
            chunk_pointer=first_pointer,
        ),
        _sender=creator,
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=immutable_object_id,
            expected_index=1,
            chunk_pointer=second_pointer,
        ),
        _sender=creator,
    )
    registry.seal_policy_to_onchain_object(
        sp.record(
            policy_id=materialized,
            expected_policy_revision=1,
            object_registry=checkpoints.address,
            object_id=immutable_object_id,
        ),
        _sender=creator,
        _valid=False,
        _exception="OBJECT_NOT_SEALED",
    )
    checkpoints.seal_checkpoint(immutable_object_id, _sender=creator)
    registry.seal_policy_to_onchain_object(
        sp.record(
            policy_id=materialized,
            expected_policy_revision=1,
            object_registry=checkpoints.address,
            object_id=immutable_object_id,
        ),
        _sender=creator,
    )
    scenario.verify(sp.View(registry, "policy_is_immutable")(materialized))
    scenario.verify(
        sp.View(registry, "policy_materialization")(materialized).index_root
        == final_root
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=materialized,
            expected_parent=1,
            value_digest=sp.sha256(raw("replacement")),
            byte_length=11,
            media_type=raw("text/css"),
        ),
        _sender=creator,
        _valid=False,
        _exception="POLICY_SEALED",
    )

    verification_manifest = policy_id(creator.address, "verification-ui")
    registry.create_policy(
        sp.record(
            policy_id=verification_manifest,
            salt=raw("verification-ui"),
            oracle=none_address,
            collection=none_address,
            token_id=0,
            media_type=raw("application/vnd.keel.verification-presentation+json"),
            max_bytes=64000,
            authority=raw("creator"),
            update_kind=raw("resource-revision"),
            value_kind=raw("binary"),
            executable=False,
        ),
        _sender=creator,
    )
    for parent, value in [(0, "manifest-v1"), (1, "manifest-v2")]:
        registry.append_resource_revision(
            sp.record(
                policy_id=verification_manifest,
                expected_parent=parent,
                value_digest=sp.sha256(raw(value)),
                byte_length=11,
                media_type=raw("application/vnd.keel.verification-presentation+json"),
            ),
            _sender=creator,
        )
    registry.append_resource_revision(
        sp.record(
            policy_id=verification_manifest,
            expected_parent=2,
            value_digest=sp.sha256(raw("wrong")),
            byte_length=5,
            media_type=raw("application/json"),
        ),
        _sender=creator,
        _valid=False,
        _exception="INVALID_MEDIA_TYPE",
    )
    scenario.verify(
        sp.View(registry, "presentation_matches")(
            sp.record(
                policy_id=verification_manifest,
                revision=2,
                value_digest=sp.sha256(raw("manifest-v2")),
                byte_length=11,
                source_manifest_digest=sp.bytes("0x"),
                source_sequence=0,
            )
        )
    )

    locked = policy_id(creator.address, "locked-code")
    registry.create_policy(
        sp.record(
            policy_id=locked,
            salt=raw("locked-code"),
            oracle=none_address,
            collection=none_address,
            token_id=0,
            media_type=raw("text/javascript"),
            max_bytes=64000,
            authority=raw("immutable"),
            update_kind=raw("viewer-revision"),
            value_kind=raw("binary"),
            executable=True,
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=locked,
            expected_parent=0,
            value_digest=sp.sha256(raw("locked")),
            byte_length=6,
            media_type=raw("text/javascript"),
        ),
        _sender=creator,
    )
    registry.append_resource_revision(
        sp.record(
            policy_id=locked,
            expected_parent=1,
            value_digest=sp.sha256(raw("replacement")),
            byte_length=11,
            media_type=raw("text/javascript"),
        ),
        _sender=creator,
        _valid=False,
        _exception="UNAUTHORIZED",
    )

    palette = policy_id(creator.address, "palette")
    registry.create_policy(
        sp.record(
            policy_id=palette,
            salt=raw("palette"),
            oracle=none_address,
            collection=sp.Some(token.address),
            token_id=7,
            media_type=raw("text/plain"),
            max_bytes=7,
            authority=raw("token-owner"),
            update_kind=raw("typed-state"),
            value_kind=raw("rgb24"),
            executable=False,
        ),
        _sender=creator,
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=palette,
            expected_parent=0,
            canonical_value=raw("#72ffd6"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
    )
    scenario.verify(sp.View(registry, "current_inline_value")(palette) == raw("#72ffd6"))
    registry.append_inline_revision(
        sp.record(
            policy_id=palette,
            expected_parent=1,
            canonical_value=raw("#72FFD6"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
        _valid=False,
        _exception="INVALID_VALUE",
    )

    token.set_owner(sp.record(token_id=7, owner=escrow.address), _sender=creator)
    registry.append_inline_revision(
        sp.record(
            policy_id=palette,
            expected_parent=1,
            canonical_value=raw("#223344"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
        _valid=False,
        _exception="UNAUTHORIZED",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=palette,
            expected_parent=1,
            canonical_value=raw("#223344"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=escrow,
    )

    token.set_owner(sp.record(token_id=7, owner=owner.address), _sender=creator)
    stake_lock = policy_id(creator.address, "stake-lock")
    registry.create_policy(
        sp.record(
            policy_id=stake_lock,
            salt=raw("stake-lock"),
            oracle=none_address,
            collection=sp.Some(token.address),
            token_id=7,
            media_type=raw("text/plain"),
            max_bytes=7,
            authority=raw("token-owner"),
            update_kind=raw("typed-state"),
            value_kind=raw("rgb24"),
            executable=False,
        ),
        _sender=creator,
    )
    scenario.verify(sp.View(registry, "staking_status")(stake_lock).configured == False)
    registry.configure_staking_rule(
        sp.record(
            policy_id=stake_lock,
            adapter=staking_adapter.address,
            mode=raw("lock-updates-while-staked"),
        ),
        _sender=creator,
    )
    staking_adapter.set_state(
        sp.record(staked=True, controller=owner.address), _sender=creator
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=stake_lock,
            expected_parent=0,
            canonical_value=raw("#112233"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
        _valid=False,
        _exception="UPDATES_LOCKED_WHILE_STAKED",
    )
    staking_adapter.set_state(
        sp.record(staked=False, controller=owner.address), _sender=creator
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=stake_lock,
            expected_parent=0,
            canonical_value=raw("#112233"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
    )

    stake_controller = policy_id(creator.address, "stake-controller")
    registry.create_policy(
        sp.record(
            policy_id=stake_controller,
            salt=raw("stake-controller"),
            oracle=none_address,
            collection=sp.Some(token.address),
            token_id=7,
            media_type=raw("text/plain"),
            max_bytes=7,
            authority=raw("token-owner"),
            update_kind=raw("typed-state"),
            value_kind=raw("rgb24"),
            executable=False,
        ),
        _sender=creator,
    )
    registry.configure_staking_rule(
        sp.record(
            policy_id=stake_controller,
            adapter=staking_adapter.address,
            mode=raw("controller-while-staked"),
        ),
        _sender=creator,
    )
    staking_adapter.set_state(
        sp.record(staked=True, controller=escrow.address), _sender=creator
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=stake_controller,
            expected_parent=0,
            canonical_value=raw("#223344"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=owner,
        _valid=False,
        _exception="UNAUTHORIZED",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=stake_controller,
            expected_parent=0,
            canonical_value=raw("#223344"),
            media_type=raw("text/plain"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=0,
        ),
        _sender=escrow,
    )

    weather = policy_id(creator.address, "weather")
    registry.create_policy(
        sp.record(
            policy_id=weather,
            salt=raw("weather"),
            oracle=sp.Some(oracle.address),
            collection=none_address,
            token_id=0,
            media_type=raw("application/json"),
            max_bytes=4096,
            authority=raw("oracle"),
            update_kind=raw("api-snapshot"),
            value_kind=raw("canonical-json"),
            executable=False,
        ),
        _sender=creator,
    )
    first_weather = raw('{"temperature":21}')
    second_weather = raw('{"temperature":22}')
    source_manifest = sp.sha256(raw("weather-source-manifest"))
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=0,
            canonical_value=first_weather,
            media_type=raw("application/json"),
            source_manifest_digest=source_manifest,
            source_sequence=7,
        ),
        _sender=attacker,
        _valid=False,
        _exception="UNAUTHORIZED",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=0,
            canonical_value=first_weather,
            media_type=raw("application/json"),
            source_manifest_digest=sp.bytes("0x"),
            source_sequence=7,
        ),
        _sender=oracle,
        _valid=False,
        _exception="API_MANIFEST_MISSING",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=0,
            canonical_value=first_weather,
            media_type=raw("application/json"),
            source_manifest_digest=source_manifest,
            source_sequence=7,
        ),
        _sender=oracle,
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=1,
            canonical_value=second_weather,
            media_type=raw("application/json"),
            source_manifest_digest=source_manifest,
            source_sequence=7,
        ),
        _sender=oracle,
        _valid=False,
        _exception="API_SEQUENCE_STALE",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=1,
            canonical_value=second_weather,
            media_type=raw("text/plain"),
            source_manifest_digest=source_manifest,
            source_sequence=8,
        ),
        _sender=oracle,
        _valid=False,
        _exception="INVALID_MEDIA_TYPE",
    )
    registry.append_inline_revision(
        sp.record(
            policy_id=weather,
            expected_parent=1,
            canonical_value=second_weather,
            media_type=raw("application/json"),
            source_manifest_digest=source_manifest,
            source_sequence=8,
        ),
        _sender=oracle,
    )
    scenario.verify(
        sp.View(registry, "presentation_matches")(
            sp.record(
                policy_id=weather,
                revision=2,
                value_digest=sp.sha256(second_weather),
                byte_length=18,
                source_manifest_digest=source_manifest,
                source_sequence=8,
            )
        )
    )
