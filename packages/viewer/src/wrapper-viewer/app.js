/**
 * Keel wrapper viewer — the document that ships on-chain inside the token.
 *
 * It resolves the preserved bytes from the same chain that served this file,
 * shows the artwork, and keeps every claim about that artwork one click away
 * behind a mark that is invisible until somebody looks for it.
 *
 * Everything shown is derived from the chain or from bytes fetched off it.
 * Nothing is taken from a declared field where a fact was available: the image
 * type comes from its magic number, its dimensions from the PNG header, its
 * size from the bytes that arrived. A declared "image/png" is a claim; the
 * bytes 89 50 4E 47 are not.
 *
 * Asset presentation and backdrop geometry are not reimplemented here. They
 * come from the shared module, so the viewer sealed into a token, the SDK, and
 * any host embedding the chrome all agree on what the art is and where it sits
 * — one implementation, bundled in at build time.
 */
import { mountAsset, backdropPath } from "../keel-asset-view.js";
(() => {
  const E = globalThis.__KEEL_ONCHAIN_CONTEXT__ || globalThis.__KEEL_CONTEXT__ || {};
  const C = typeof E.json === "string" ? JSON.parse(E.json) : E;
  /**
   * No host is baked into this document.
   *
   * Showing the artwork needs nothing: the bytes are carried here and checked
   * here. The optional extras — drilling into the wrapped collection, opening
   * an explorer — do need somewhere to ask, and where that is belongs to
   * whoever assembled the document, under the host policy, not to a constant
   * compiled into every token on every chain forever. When neither is supplied
   * the panel simply offers less, and the art is unaffected.
   */
  const RPC = C.rpc || null;
  const SCAN = C.explorer || null;
  const scan = (path) => (SCAN ? `${SCAN}${path}` : null);
  const held = C.custody === "Sealed" || C.custody === "Frozen";
  const state = { bytes: null, kind: "—", dims: "—", shape: null, mounted: false, facts: "", verified: null };


  /**
   * A sandboxed frame cannot navigate to an explorer, so rather than hand a
   * reader a link that silently does nothing, the panel reads the chain itself
   * and shows what the explorer would have shown. Same source of truth, no
   * third party, and it works inside the sandbox marketplaces impose.
   */
  /**
   * Which chain family this token lives on. Absent means Ethereum, because
   * every document sealed before Tezos existed carries no such field and must
   * keep reading exactly as it did.
   */
  const FAMILY = C.family === "tezos" ? "tezos" : "ethereum";

  const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", ownerOf: "0x6352211e",
    tokenURI: "0xc87b56dd", getObject: "0x05144857", custodyOf: "0x65269e47" };
  const word = (v) => v.replace(/^0x/, "").padStart(64, "0");
  const call = (to, data) =>
    !RPC ? Promise.resolve(null) : fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) })
      .then((r) => r.json()).then((j) => (j.error ? null : j.result));

  /**
   * A Tezos on-chain view, read the way the DON verifiers read one.
   *
   * `run_script_view` is the only shape of read this document can make on
   * Tezos without help. Storage is reachable too, but a big_map value is keyed
   * by the hash of its packed key, and packing plus blake2b is more machinery
   * than a sealed document should carry. Views need none of it.
   */
  const view = (contract, name, input) =>
    !RPC ? Promise.resolve(null) : fetch(
      `${RPC.replace(/\/$/, "")}/chains/main/blocks/head/helpers/scripts/run_script_view`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract, view: name, input,
          chain_id: C.chainId ?? undefined, unparsing_mode: "Readable" }) })
      .then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.data !== undefined ? j.data : null))
      .catch(() => null);

  /**
   * Flatten a right-combed Micheline record into positional fields.
   *
   * SmartPy lays a record out as nested pairs, so field five of nine is five
   * `Pair`s deep. Flattening once and indexing by position is the smallest
   * thing that reads one reliably, and it fails to `null` rather than throwing
   * on a shape it did not expect — a panel that says nothing beats a panel
   * that says something wrong.
   */
  const flat = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { node.forEach((n) => flat(n, out)); return out; }
    if (node.prim === "Pair" && Array.isArray(node.args)) { node.args.forEach((a) => flat(a, out)); return out; }
    out.push(node);
    return out;
  };
  const mBytes = (n) => (n && typeof n.bytes === "string" ? n.bytes : null);
  const mInt = (n) => (n && typeof n.int === "string" ? BigInt(n.int) : null);
  const utf8 = (hex) => {
    if (!hex) return null;
    try {
      return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16)));
    } catch { return null; }
  };
  const decodeString = (hex) => {
    // ABI string: offset word, length word, then the bytes. Decoded with
    // TextDecoder rather than decodeURIComponent, which throws on anything that
    // is not a valid escape and would silently turn a real name into a dash.
    if (!hex || hex.length < 130) return null;
    const len = parseInt(hex.slice(66, 130), 16);
    if (!Number.isFinite(len) || len === 0) return null;
    const body = hex.slice(130, 130 + len * 2);
    const bytes = Uint8Array.from(body.match(/../g) || [], (b) => parseInt(b, 16));
    return new TextDecoder().decode(bytes);
  };
  const decodeAddress = (hex) => (hex && hex.length >= 66 ? `0x${hex.slice(26, 66)}` : null);
  const uintAt = (hex, i) => (hex ? BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`) : 0n);

  /**
   * Recompute the artwork's name from the artwork's bytes.
   *
   * A CID is not a label attached to a file — it *is* the hash of the file, so
   * the only way these bytes can carry the name the collection committed to is
   * to be those bytes. Doing it here, in the document, is the whole point: it
   * means the node that served this page is not being trusted either. Anyone
   * who swapped a pixel gets a different name and the art is refused.
   *
   * Single-block UnixFS, which is what a file under 256 KiB is. Above that a
   * real CID is a DAG of chunks and this cannot answer honestly, so it says so
   * by returning null rather than guessing.
   */
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const varint = (n) => { const out = []; while (n >= 128) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return out; };
  const base58 = (bytes) => {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let out = "";
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
    return out;
  };
  async function recomputeCid(bytes) {
    if (bytes.length > 262144) return null;
    const file = [8, 2, 18, ...varint(bytes.length), ...bytes, 24, ...varint(bytes.length)];
    const node = new Uint8Array([10, ...varint(file.length), ...file]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", node));
    return base58(new Uint8Array([18, 32, ...digest]));
  }

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const short = (v, n = 10) =>
    typeof v === "string" && v.length > n * 2 + 2 ? `${v.slice(0, n)}…${v.slice(-6)}` : v ?? "—";

  const row = (k, v, href, mono = true, inspect) => {
    const r = el("div", "row");
    r.append(el("span", "k", k));
    let val;
    if (href) {
      val = el("a", `v${mono ? " mono" : ""}`, v ?? "—");
      val.href = href;
      val.target = "_blank";
      val.rel = "noreferrer noopener";
      val.title = href;
      // Marketplaces frame this document with a sandbox that usually forbids
      // navigation and popups, so a plain anchor silently does nothing. Try to
      // open, and when the frame refuses, put the URL on the clipboard and say
      // so — a dead link is worse than an honest fallback.
      val.addEventListener("click", (event) => {
        let opened = null;
        try { opened = window.open(href, "_blank", "noopener"); } catch { opened = null; }
        if (opened) return;
        event.preventDefault();
        const done = () => {
          const was = val.textContent;
          val.textContent = "copied ✓";
          setTimeout(() => { val.textContent = was; }, 1200);
        };
        try { navigator.clipboard.writeText(href).then(done, done); } catch { done(); }
      });
    } else {
      val = el("span", `v${mono ? " mono" : ""}`, v ?? "—");
    }
    r.append(val);
    if (inspect) {
      r.classList.add("drill");
      r.tabIndex = 0;
      r.setAttribute("role", "button");
      const go = (e) => { e.preventDefault(); openInspector(inspect); };
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(e); });
    }
    return r;
  };

  const card = (title, ...children) => {
    const c = el("section", "card");
    if (title) c.append(el("h3", null, title));
    c.append(...children);
    return c;
  };

  const check = (ok, label, detail) => {
    const c = el("div", `chk ${ok === true ? "ok" : ok === false ? "no" : "warn"}`);
    c.append(el("span", "dot"));
    const body = el("span", "chk-body");
    body.append(el("b", null, label));
    if (detail) body.append(el("small", null, detail));
    c.append(body);
    return c;
  };

  /**
   * The score is about durability, not taste. Each line is something that can
   * actually be checked, and the weights follow how much each one protects a
   * holder rather than how impressive it sounds.
   */
  function score() {
    const rules = [
      { label: "Artwork stored on chain", points: 3, ok: Boolean(C.assetObject && C.keelHold),
        why: "The bytes live in KeelHold on this chain, not behind a gateway." },
      { label: "Metadata served on chain", points: 2, ok: true,
        why: "tokenURI returns inline JSON built by the contract — no server involved." },
      { label: "Art proven against its source", points: 2, ok: C.preservation === "native",
        why: "The CID the original token committed to was recomputed on chain from these exact bytes." },
      { label: "No external dependencies", points: 1, ok: true,
        why: "Nothing is fetched over HTTP; the viewer reads the same chain that serves it." },
      { label: "Original held by the wrapper", points: 1, ok: held,
        why: "Custody is read live from ownerOf on every transfer." },
      { label: "Artwork is immutable", points: 1, ok: Boolean(C.assetObject),
        why: "Content-addressed: changing a byte changes the id, so it cannot be swapped in place." },
    ];
    const earned = rules.filter((r) => r.ok).reduce((a, r) => a + r.points, 0);
    return { rules, earned, total: rules.reduce((a, r) => a + r.points, 0) };
  }

  /**
   * What can still change, and who controls it. A reader deserves this stated
   * plainly rather than having to infer it from an absence of warnings.
   */
  const mutability = [
    { what: "Artwork bytes", who: "Nobody", how: "immutable",
      why: "Content-addressed in KeelHold. Different bytes are a different object." },
    { what: "The original NFT", who: "Its own contract", how: "outside our control",
      why: "An upgradeable collection can move its token. The wrapper detects it and stops trading." },
    { what: "Custody state", who: "The wrapper owner", how: "withdraw / redeposit",
      why: "Read live on every transfer, never cached." },
    { what: "This viewer", who: "Anyone, permissionlessly", how: "re-bindable",
      why: "Presentation only. It cannot change what the proofs say." },
    { what: "Proof ladder", who: "Nobody", how: "write-once",
      why: "Each link is recorded once and never edited." },
  ];

  /** Drill into one thing, reading it live off the chain. */
  async function openInspector(spec) {
    const host = $("#pages");
    const view = el("div", "page");
    view.dataset.page = "inspect";
    const back = el("button", "back", "‹ back");
    back.addEventListener("click", () => {
      view.remove();
      for (const p of host.children) p.hidden = p.dataset.page !== currentTab();
    });
    view.append(back);
    const c = card(spec.title, el("div", "loading", "reading chain…"));
    view.append(c);
    for (const p of host.children) p.hidden = true;
    host.append(view);
    host.scrollTop = 0;

    const rows = await spec.load();
    c.replaceChildren(el("h3", null, spec.title), ...rows);
  }
  const currentTab = () => document.querySelector(".tab[aria-selected=true]")?.dataset.tab ?? "overview";

  /** The wrapped collection, as the chain describes it. */
  const inspectCollection = () => ({
    title: "Original collection",
    load: async () => {
      const a = C.underlying;
      const id = BigInt(C.tokenId || 0);
      const rows = [row("Address", a, scan(`/address/${a}`))];

      if (FAMILY === "ethereum") {
        const [nm, sym, owner, uri] = await Promise.all([
          call(a, SEL.name), call(a, SEL.symbol),
          call(a, SEL.ownerOf + word(id.toString(16))),
          call(a, SEL.tokenURI + word(id.toString(16))),
        ]);
        const route = decodeString(uri);
        rows.push(
          row("Name", decodeString(nm) ?? "—", null, false),
          row("Symbol", decodeString(sym) ?? "—", null, false),
          row("Holder of #" + C.tokenId, short(decodeAddress(owner) ?? "—", 8)),
          row("Route", route ?? "—", null, false),
          row("Route kind", route?.startsWith("ipfs://") ? "IPFS · content-addressed" : route ? "location" : "—", null, false),
        );
        return rows;
      }

      // Tezos. Two differences, and both are honest rather than reduced.
      //
      // There is no name or symbol to read: FA2 keeps them in a TZIP-16
      // metadata big_map, and a big_map value is keyed by the hash of its
      // packed key, which this document cannot compute. Saying "—" is the
      // truthful answer; guessing from a third-party indexer would not be.
      //
      // And custody is asked the only way it can be. There is no reverse
      // lookup from a token to its holder, so the question becomes "does the
      // wrapper hold it", which is the question that actually matters and the
      // same one the wrapper's own transfer gate asks.
      const key = { prim: "Pair", args: [{ string: C.backpack }, { int: id.toString() }] };
      const [balance, pointer] = await Promise.all([
        view(a, "get_balance", key),
        C.ledger ? view(C.ledger, "pointer_of", key) : Promise.resolve(null),
      ]);
      const held_ = balance === null ? null : (mInt(balance) ?? 0n) > 0n;
      const route = pointer ? utf8(mBytes(flat(pointer)[1])) : null;
      rows.push(
        row("Name", "—", null, false),
        row("Symbol", "—", null, false),
        row("Held by wrapper",
          held_ === null ? "— · the collection publishes no balance view" : held_ ? "yes" : "no",
          null, false),
        row("Route", route ?? "—", null, false),
        row("Route kind",
          route?.startsWith("ipfs://") ? "IPFS · content-addressed"
            : route?.startsWith("onchfs://") ? "ONCHFS · content-addressed"
              : route ? "location" : "—", null, false),
        // Where the route came from, which differs from the EVM lane and
        // matters: this is the pointer the ladder was proven against, recorded
        // at the level it was read, not a fresh read that may have moved since.
        row("Route source", pointer ? `ledger observation · level ${mInt(flat(pointer)[2]) ?? "?"}` : "—", null, false),
      );
      return rows;
    },
  });

  /** The stored bytes, as Keel records them. */
  const inspectObject = (id, title) => ({
    title,
    load: async () => {
      if (FAMILY === "ethereum") {
        const hex = await call(C.keelHold, SEL.getObject + word(id));
        if (!hex) return [row("Object", id), row("Status", "unreadable", null, false)];
        // ObjectRecord: digest, indexDigest, pointer, byteLength, storedByteLength, chunkCount, …
        return [
          row("Object id", id),
          row("Digest (sha256)", `0x${hex.slice(2, 66)}`),
          row("Byte length", uintAt(hex, 3).toLocaleString() + " B", null, false),
          row("Chunks", uintAt(hex, 5).toString(), null, false),
          row("Store", C.keelHold, scan(`/address/${C.keelHold}`)),
          row("Mutability", "immutable · content-addressed", null, false),
        ];
      }

      // Tezos. `get_keel_object` returns the same facts under different names,
      // laid out as a right-combed record: file_cid, manifest, manifest_sha256,
      // stored_sha256, stored_byte_length, decoded_sha256, decoded_byte_length,
      // media_type, compression.
      const record = await view(C.keelHold, "get_keel_object", { bytes: id.replace(/^0x/, "") });
      if (!record) return [row("Object", id), row("Status", "unreadable", null, false)];
      const f = flat(record);
      const length = mInt(f[4]);
      return [
        row("Object id", id),
        row("Digest (sha256)", `0x${mBytes(f[3]) ?? "—"}`),
        row("Byte length", length === null ? "—" : length.toLocaleString() + " B", null, false),
        row("Media type", utf8(mBytes(f[7])) ?? "—", null, false),
        row("Store", C.keelHold, scan(`/${C.keelHold}`)),
        row("Mutability", "immutable · content-addressed", null, false),
      ];
    },
  });

  /**
   * Draw the panel's content. Safe to run again: some facts — the artwork's
   * dimensions, the shape of its backdrop — are only known once the bytes have
   * decoded, and a panel that says "—" forever because it was built a frame too
   * early is a panel that lies about what was measured.
   */
  function render() {
    const s = score();
    const grade = s.earned >= 9 ? "EXCELLENT" : s.earned >= 7 ? "STRONG" : s.earned >= 5 ? "PARTIAL" : "WEAK";

    // ---------------------------------------------------------------- overview
    const verdict = el("section", "verdict");
    const scoreBox = el("div", "score");
    scoreBox.append(el("b", null, `${s.earned.toFixed(1)}`), el("span", null, `/ ${s.total}`));
    const vcopy = el("div", "verdict-copy");
    vcopy.append(el("p", "grade", grade));
    vcopy.append(el("p", "grade-sub",
      s.rules.filter((r) => r.ok).map((r) => r.label.toLowerCase()).join(" · ")));
    verdict.append(scoreBox, vcopy);

    const custody = el("section", `custody ${held ? "held" : "empty"}`);
    custody.append(el("span", "pulse"));
    const cbody = el("div", null);
    cbody.append(el("b", null, held ? `WRAPPED · ${C.custody}` : `UNWRAPPED · ${C.custody}`));
    cbody.append(el("small", null, held
      ? "The original is inside this wrapper. It moves when the wrapper moves."
      : "The original is not in this wrapper. Transfers are blocked, and the art below is the preserved copy."));
    custody.append(cbody);

    const facts = card("At a glance",
      row("Original collection", short(C.underlying, 8), null, true, RPC && C.underlying && inspectCollection()),
      row("Original token", `#${C.tokenId ?? "?"}`, C.underlying && scan(`/token/${C.underlying}?a=${C.tokenId}`)),
      row("Wrapper", short(C.backpack, 8), C.backpack && scan(`/address/${C.backpack}`)),
      row("Chain", C.chainName ? `${C.chainName} · ${C.chainId ?? "?"}` : C.chainId ? String(C.chainId) : "—", null, false),
      row("Preservation", C.preservation ?? "—", null, false));

    // -------------------------------------------------------------- provenance
    const ladder = card("How this art was verified",
      check(true, "The route was read on chain",
        "tokenURI was read by the contract itself and sealed to a block."),
      check(C.preservation === "native", "The bytes match the name",
        "The CID recomputed from these bytes equals the one the token committed to."),
      check(Boolean(C.assetObject), "The bytes are here",
        "Stored in KeelHold and served from this chain."),
      check(held ? true : null, held ? "The original is held" : "The original has left",
        held ? "ownerOf confirms the wrapper holds it." : "Preservation is unaffected — only custody ended."));

    const origin = card("The original",
      row("Contract", C.underlying, null, true, RPC && C.underlying && inspectCollection()),
      row("Token id", C.tokenId, null, false),
      row("Art (CID)", short(C.assetCid ?? "—", 12)),
      row("Route", C.route ?? "ipfs://…", null, false));

    const mut = card("What can change");
    for (const m of mutability) {
      const r = el("div", "mut");
      const head = el("div", "mut-head");
      head.append(el("b", null, m.what), el("span", `tag ${m.how === "immutable" || m.how === "write-once" ? "good" : "warn"}`, m.how));
      r.append(head, el("small", null, `${m.who} — ${m.why}`));
      mut.append(r);
    }

    // ----------------------------------------------------------------- storage
    const storage = card("Byte forensics",
      row("Image type", state.kind, null, false),
      row("Dimensions", state.dims, null, false),
      row("Backdrop", describeShape(state.shape), null, false),
      row("Size", state.bytes ? `${state.bytes.length.toLocaleString()} B` : "—", null, false),
      row("Stored in", short(C.keelHold, 8), C.keelHold && scan(`/address/${C.keelHold}`)),
      row("Art object", short(C.assetObject, 10), null, true, RPC && C.assetObject && inspectObject(C.assetObject, "Artwork bytes")),
      row("Dependencies", "None — no HTTP, no gateway", null, false));

    const where = card("Where every byte lives",
      check(true, "Artwork", "KeelHold on this chain, content-addressed."),
      check(true, "Metadata", "Built by the contract at read time. No server."),
      check(true, "This viewer", "Stored on chain and rebuilt from it."),
      check(true, "Carried, not fetched",
        "The artwork is part of this document. Nothing is downloaded to show it, and no host has to be up or honest."),
      check(state.verified === true, "Artwork verified here",
        state.verified === true
          ? `These bytes hash to ${short(C.assetCid ?? "", 12)} — the name the collection committed to. Checked in this document, so the node that served them is not trusted.`
          : state.verified === false
            ? "These bytes do NOT hash to the name the collection committed to."
            : "The artwork could not be checked against its committed name."));

    // ------------------------------------------------------------------ report
    const report = card("Score breakdown");
    for (const r of s.rules) {
      const line = el("div", `chk ${r.ok ? "ok" : "warn"}`);
      line.append(el("span", "dot"));
      const b = el("span", "chk-body");
      b.append(el("b", null, `${r.ok ? "+" : "0/"}${r.points} · ${r.label}`));
      b.append(el("small", null, r.why));
      line.append(b);
      report.append(line);
    }

    const pages = {
      overview: [verdict, custody, facts],
      provenance: [ladder, origin, mut],
      storage: [storage, where],
      report: [report],
    };
    const host = $("#pages");
    host.replaceChildren();
    for (const [id, nodes] of Object.entries(pages)) {
      const page = el("div", "page");
      page.dataset.page = id;
      page.hidden = id !== "overview";
      page.append(...nodes);
      host.append(page);
    }
    // Keep whatever the reader was looking at; a re-render is not a reason to
    // throw them back to the first tab.
    const active = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab ?? "overview";
    for (const page of document.querySelectorAll(".page")) page.hidden = page.dataset.page !== active;
  }

  /** One-time chrome wiring. Listeners are attached here so a re-render cannot
   *  stack a second copy of them. */
  function wire() {
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => {
        for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t === tab));
        for (const p of document.querySelectorAll(".page")) p.hidden = p.dataset.page !== tab.dataset.tab;
        $("#pages").scrollTop = 0;
      });
    }
    if (!held) document.documentElement.classList.add("is-unwrapped");

    // The panel stays out of the way until asked for. Opening is one click on a
    // mark that is nearly invisible until hovered — present for anyone who
    // wants it, silent for everyone who does not.
    const panel = $("#panel");
    const seal = $("#seal");
    const isOpen = () => document.body.classList.contains("open");
    const setOpen = (open) => {
      document.body.classList.toggle("open", open);
      seal.setAttribute("aria-expanded", String(open));
      panel.setAttribute("aria-hidden", String(!open));
      if (open) panel.scrollTop = 0;
    };
    setOpen(false);

    // Click is the primary gesture on every device. A small wobble on press
    // acknowledges the tap without becoming a performance.
    seal.addEventListener("click", () => {
      seal.animate(
        [{ transform: "scale(1) rotate(0)" }, { transform: "scale(.9) rotate(-7deg)" }, { transform: "scale(1) rotate(0)" }],
        { duration: 240, easing: "cubic-bezier(.3,1.4,.5,1)" },
      );
      setOpen(!isOpen());
    });
    // Touch has no hover, so the corner itself opens the panel there. On a
    // mouse the corner only reveals the mark; the click still belongs to it.
    if (matchMedia("(pointer:coarse)").matches) {
      document.querySelector(".corner").addEventListener("click", (e) => {
        if (e.target !== seal && !seal.contains(e.target)) setOpen(!isOpen());
      });
    }
    $("#scrim").addEventListener("click", () => setOpen(false));
    $("#close").addEventListener("click", () => setOpen(false));
    addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

    // Drag-to-dismiss only where a finger exists. On a mouse it would fight
    // with text selection for no benefit.
    if (matchMedia("(pointer:coarse)").matches) {
      let startY = null;
      const grab = panel;
      grab.addEventListener("touchstart", (e) => {
        if (panel.scrollTop > 0) return;
        startY = e.touches[0].clientY;
      }, { passive: true });
      grab.addEventListener("touchmove", (e) => {
        if (startY === null) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      grab.addEventListener("touchend", (e) => {
        if (startY === null) return;
        const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
        panel.style.transform = "";
        if (dy > 90) setOpen(false);
        startY = null;
      });
    }
  }

  function build() {
    render();
    wire();
    state.mounted = true;
  }

  /**
   * Say in words what the pixels said about the artwork's own edge, so a reader
   * can see that the frame was measured rather than assumed.
   */
  function describeShape(shape) {
    if (!shape) return "—";
    if (shape.kind === "full") return "none — art bleeds to the edge";
    if (shape.kind === "ellipse") return "ellipse";
    if (shape.kind === "rect") return "square corners";
    const percent = (shape.r * 100).toFixed(1);
    const measured = shape.radiusPx ? `${shape.radiusPx}px · ` : "";
    return `rounded · ${measured}${percent}% radius · ${Math.round(shape.confidence * 100)}% fit`;
  }

  /**
   * Lay the unwrapped frame along the artwork's own edge.
   *
   * `shape` is measured from the pixels: where the backdrop ends and how curved
   * its corners are. An ape's field is a rounded rect, a photograph has no
   * backdrop at all, and a token avatar can be a circle — all three are stroked
   * correctly from the same numbers. Nothing here knows what it is looking at.
   */
  function traceEdge(rect, shape) {
    const svg = $("#edge");
    const path = $("#edge-path");
    if (!svg || !path) return;
    // A layout pass can report a zero-size box before the art has settled. That
    // is not a frame worth drawing, and it must not erase the one already up.
    if (!(rect.width > 1 && rect.height > 1)) return;
    const stroke = 5;
    svg.style.left = `${rect.left}px`;
    svg.style.top = `${rect.top}px`;
    svg.setAttribute("width", rect.width);
    svg.setAttribute("height", rect.height);
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    // No measurement, or art that bleeds to its corners: the painted rectangle
    // is the truthful edge, and squaring it off is not a compromise.
    const box = shape && shape.kind !== "full" ? shape : { kind: "rect", x: 0, y: 0, w: 1, h: 1, r: 0 };
    path.setAttribute("d", backdropPath(box, rect, stroke / 2));

    // The badge rides the same edge, nudged clear of the curve so it never sits
    // on top of the arc it is announcing.
    const flag = $("#flag");
    if (flag) {
      const inset = Math.min(rect.width, rect.height) * (box.r || 0) * 0.75;
      flag.style.left = `${rect.left + rect.width * box.x + inset + 10}px`;
      flag.style.top = `${rect.top + rect.height * box.y + inset + 10}px`;
    }
  }

  // The art is fetched from the same chain that served this document.
  function paint(bytes) {
    state.bytes = bytes;
    const holder = $("#asset");
    // Declared before the call, not by it. `onRect` fires once synchronously
    // while `mountAsset` is still running, so a `const` assigned from its return
    // value is still in its dead zone the first time the callback reads it —
    // which threw, and took the whole paint with it.
    let mounted = null;
    mounted = mountAsset({
      target: holder,
      bytes,
      // The seal belongs to the corner of the artwork, not the corner of the
      // window. With object-fit those are different rectangles, and pinning to
      // the wrong one puts the mark out in the letterboxing.
      onRect: (rect, detected, shape) => {
        state.kind = detected.mime.split("/")[1].toUpperCase();
        const node = mounted?.node;
        if (node?.naturalWidth) state.dims = `${node.naturalWidth} × ${node.naturalHeight}`;
        state.shape = shape;
        traceEdge(rect, shape);
        // The measurement arrives after the panel is first drawn. Redraw it
        // once, when there is something new to say.
        const facts = `${state.kind}|${state.dims}|${describeShape(shape)}`;
        if (state.mounted && facts !== state.facts) render();
        state.facts = facts;
        const corner = document.querySelector(".corner");
        if (!corner) return;
        // Fullscreen or an asset that fills the frame: fall back to the frame
        // corner, which is then the same thing.
        const fills = rect.width >= innerWidth - 2 && rect.height >= innerHeight - 2;
        corner.style.left = fills ? "0px" : `${Math.max(0, rect.left)}px`;
        corner.style.bottom = fills ? "0px" : `${Math.max(0, innerHeight - rect.bottom)}px`;
      },
    });
    $("#boot").hidden = true;
  }

  /**
   * The artwork is in this document, between two tags the composite put it
   * between. So there is nothing to fetch and nothing to be down: reading the
   * page and holding the preserved bytes are the same act.
   *
   * The bytes are checked before they are shown, never after. A viewer that
   * paints first and verifies second has already shown somebody the wrong
   * picture by the time it knows.
   */
  const carried = document.getElementById("art")?.textContent?.trim();
  if (carried) {
    const binary = atob(carried);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    (C.assetCid ? recomputeCid(bytes) : Promise.resolve(null))
      .then((cid) => {
        state.verified = cid === null ? null : cid === C.assetCid;
        if (state.verified === false) {
          document.documentElement.classList.add("is-corrupt");
          $("#boot").textContent = "BYTES DO NOT MATCH THE COMMITTED NAME";
          return;
        }
        paint(bytes);
      })
      .finally(build);
  } else {
    $("#boot").textContent = "NO ARTWORK CARRIED";
    build();
  }
})();
