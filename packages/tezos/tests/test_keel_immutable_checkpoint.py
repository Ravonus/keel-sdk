import hashlib

import smartpy as sp

from contracts.keel_immutable_checkpoint import (
    keel_immutable_checkpoint_module,
    keel_immutable_checkpoint_types,
)
from contracts.keel_chunk_store import (
    keel_chunk_store_module,
)


def raw(value: str) -> sp.Expr:
    return sp.bytes("0x" + value.encode().hex())


VIEWER_FAILURE_HTML = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Keel object unavailable</title></head>'
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#2b070d;color:#ffd7dc;'
    'font-family:ui-monospace,monospace"><main style="max-width:520px;padding:32px">'
    '<h1 style="font-size:18px">KEEL OBJECT UNAVAILABLE</h1>'
    '<p style="font-size:13px;line-height:1.6">This Tezos checkpoint cannot serve a verified HTML viewer for the '
    "requested object: it is missing, unsealed, compressed, or not an HTML entrypoint. No substitute bytes are ever "
    "returned.</p></main></body></html>"
)


def context_injection(context: bytes) -> str:
    digest = hashlib.sha256(context).hexdigest()
    return (
        '<script>(()=>{const h="' + context.hex() + '";const b=new Uint8Array(h.length/2);'
        "for(let i=0;i<b.length;i++)b[i]=parseInt(h.substr(i*2,2),16);const j=new TextDecoder().decode(b);"
        "globalThis.__OCA_CONTEXT__=Object.freeze(JSON.parse(j));"
        "globalThis.__KEEL_ONCHAIN_CONTEXT__=Object.freeze({json:j,digest:\"0x" + digest + '",byteLength:'
        + str(len(context)) + "})})()</script>"
    )


@sp.add_test()
def keel_resumable_immutable_checkpoint():
    scenario = sp.test_scenario(
        "Keel resumable immutable checkpoint",
        [
            keel_chunk_store_module,
            keel_immutable_checkpoint_types,
            keel_immutable_checkpoint_module,
        ],
    )
    creator = sp.test_account("Creator")
    attacker = sp.test_account("Attacker")
    store = keel_chunk_store_module.KeelKeelHold(creator.address)
    checkpoints = (
        keel_immutable_checkpoint_module.KeelImmutableCheckpointRegistry()
    )
    scenario += store
    scenario += checkpoints

    first = raw("first immutable chunk")
    second = raw("second immutable chunk")
    first_pointer = sp.keccak(first)
    second_pointer = sp.keccak(second)
    store.write_chunk(first, _sender=creator)
    store.write_chunk(second, _sender=creator)

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
                    byte_length=21,
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
                    byte_length=22,
                ),
                keel_immutable_checkpoint_types.rolling_step,
            )
        )
    )
    complete = sp.concat([first, second])
    identity = sp.cast(
        sp.record(
            chunk_store=store.address,
            expected_index_root=final_root,
            expected_chunk_count=2,
            expected_stored_sha256=sp.sha256(complete),
            expected_stored_byte_length=43,
            decoded_sha256=sp.sha256(complete),
            decoded_byte_length=43,
            media_type=raw("text/css"),
            compression=raw("none"),
        ),
        keel_immutable_checkpoint_types.identity,
    )
    object_id = sp.sha256(sp.pack(identity))
    checkpoints.begin_checkpoint(
        sp.record(object_id=object_id, identity=identity), _sender=creator
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=object_id,
            expected_index=0,
            chunk_pointer=first_pointer,
        ),
        _sender=attacker,
        _valid=False,
        _exception="UNAUTHORIZED",
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=object_id,
            expected_index=0,
            chunk_pointer=first_pointer,
        ),
        _sender=creator,
    )
    checkpoints.seal_checkpoint(
        object_id,
        _sender=creator,
        _valid=False,
        _exception="CHECKPOINT_INCOMPLETE",
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=object_id,
            expected_index=1,
            chunk_pointer=second_pointer,
        ),
        _sender=creator,
    )
    checkpoints.seal_checkpoint(object_id, _sender=creator)

    immutable = sp.View(checkpoints, "get_immutable_object")(object_id)
    scenario.verify(immutable.index_root == final_root)
    scenario.verify(immutable.chunk_count == 2)
    scenario.verify(immutable.stored_byte_length == 43)
    scenario.verify(immutable.decoded_sha256 == sp.sha256(complete))
    scenario.verify(
        sp.View(checkpoints, "read_immutable_object")(object_id) == complete
    )
    scenario.verify(
        sp.View(checkpoints, "read_checkpoint_pointer")(
            sp.record(object_id=object_id, index=1)
        )
        == second_pointer
    )
    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=object_id,
            expected_index=2,
            chunk_pointer=second_pointer,
        ),
        _sender=creator,
        _valid=False,
        _exception="OBJECT_SEALED",
    )
    checkpoints.seal_checkpoint(
        object_id,
        _sender=creator,
        _valid=False,
        _exception="OBJECT_SEALED",
    )

    # The viewer lane serves only sealed, uncompressed text/html entrypoints:
    # the sealed text/css object above fails closed to the failure document.
    scenario.verify(
        sp.View(checkpoints, "viewer_html")(object_id) == raw(VIEWER_FAILURE_HTML)
    )

    viewer_source = (
        '<!doctype html><html><head><meta charset="utf-8"></head>'
        "<body>keel viewer</body></html>"
    )
    viewer_bytes = raw(viewer_source)
    viewer_pointer = sp.keccak(viewer_bytes)
    store.write_chunk(viewer_bytes, _sender=creator)
    viewer_root = sp.keccak(
        sp.pack(
            sp.cast(
                sp.record(
                    previous=empty_root,
                    index=0,
                    chunk_pointer=viewer_pointer,
                    byte_length=len(viewer_source.encode()),
                ),
                keel_immutable_checkpoint_types.rolling_step,
            )
        )
    )
    viewer_identity = sp.cast(
        sp.record(
            chunk_store=store.address,
            expected_index_root=viewer_root,
            expected_chunk_count=1,
            expected_stored_sha256=sp.sha256(viewer_bytes),
            expected_stored_byte_length=len(viewer_source.encode()),
            decoded_sha256=sp.sha256(viewer_bytes),
            decoded_byte_length=len(viewer_source.encode()),
            media_type=raw("text/html"),
            compression=raw("none"),
        ),
        keel_immutable_checkpoint_types.identity,
    )
    viewer_object_id = sp.sha256(sp.pack(viewer_identity))
    checkpoints.begin_checkpoint(
        sp.record(object_id=viewer_object_id, identity=viewer_identity),
        _sender=creator,
    )

    # Unsealed viewers also fail closed instead of leaking partial bytes.
    scenario.verify(
        sp.View(checkpoints, "viewer_html")(viewer_object_id)
        == raw(VIEWER_FAILURE_HTML)
    )

    checkpoints.append_checkpoint_chunk(
        sp.record(
            object_id=viewer_object_id,
            expected_index=0,
            chunk_pointer=viewer_pointer,
        ),
        _sender=creator,
    )
    checkpoints.seal_checkpoint(viewer_object_id, _sender=creator)

    scenario.verify(
        sp.View(checkpoints, "viewer_html")(viewer_object_id) == viewer_bytes
    )

    context = b'{"tokenId":"7"}'
    expected_with_context = (
        "<!doctype html>"
        + context_injection(context)
        + viewer_source[len("<!doctype html>"):]
    )
    scenario.verify(
        sp.View(checkpoints, "viewer_html_with_context")(
            sp.record(
                object_id=viewer_object_id,
                context_json=sp.bytes("0x" + context.hex()),
            )
        )
        == raw(expected_with_context)
    )

    # Oversized or empty context envelopes fail closed as well.
    scenario.verify(
        sp.View(checkpoints, "viewer_html_with_context")(
            sp.record(
                object_id=viewer_object_id,
                context_json=sp.bytes("0x" + (b"7" * 4097).hex()),
            )
        )
        == raw(VIEWER_FAILURE_HTML)
    )
    scenario.verify(
        sp.View(checkpoints, "viewer_html_with_context")(
            sp.record(object_id=viewer_object_id, context_json=sp.bytes("0x"))
        )
        == raw(VIEWER_FAILURE_HTML)
    )
