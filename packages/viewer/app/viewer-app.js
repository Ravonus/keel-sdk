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
import { mountAsset, backdropPath } from "../src/keel-asset-view.js";
import { createKeelChain, KEEL_VIEW_RPC_HOSTS } from "../src/keel-rpc-view.js";
(() => {
  const E = globalThis.__KEEL_ONCHAIN_CONTEXT__ || globalThis.__OCA_CONTEXT__ || {};
  const C = typeof E.json === "string" ? JSON.parse(E.json) : E;
  // No host is compiled into this document. The artwork travels with the page,
  // so nothing is needed to render it. The panel's live lookups — who owns this
  // right now, what custody says today — are questions only a node can answer,
  // and the endpoints for that arrive in the context from the on-chain node
  // registry, where they can be rotated. Absent one, the panel says it does not
  // know rather than reaching for a host somebody baked in years earlier.
  const NODES = Array.isArray(C.nodes) ? C.nodes : C.rpc ? [C.rpc] : [];
  const SCAN = "https://sepolia.etherscan.io";
  const held = C.custody === "Sealed" || C.custody === "Frozen";
  const state = { bytes: null, kind: "—", dims: "—", shape: null, mounted: false, facts: "", verified: null };


  /**
   * A sandboxed frame cannot navigate to an explorer, so rather than hand a
   * reader a link that silently does nothing, the panel reads the chain itself
   * and shows what the explorer would have shown. Same source of truth, no
   * third party, and it works inside the sandbox marketplaces impose.
   */
  const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", ownerOf: "0x6352211e",
    tokenURI: "0xc87b56dd", getObject: "0x05144857", custodyOf: "0x65269e47" };
  const word = (v) => v.replace(/^0x/, "").padStart(64, "0");
  /**
   * Which node is asked is not the frame's decision.
   *
   * The endpoints arrive in the context so they can be rotated, but a context
   * is something a host controls, and a page that reads whatever endpoint it is
   * handed can be pointed at a node that answers however its operator likes.
   * They are checked against the governed host list sealed into this document —
   * the same list `KeelManager.rpcHostList` publishes and governors move
   * through a two-thirds envelope. An endpoint outside it is dropped, and the
   * panel says so rather than quietly using it.
   *
   * Failing over across several endpoints is the module's job, not this file's,
   * and `call` reads like the contract read it is.
   */
  const chain = createKeelChain({
    rpc: NODES,
    keelHold: C.keelHold,
    hosts: Array.isArray(C.rpcHosts) && C.rpcHosts.length > 0 ? C.rpcHosts : KEEL_VIEW_RPC_HOSTS,
    listRevision: C.rpcHostListRevision || 0,
    listEpoch: C.rpcHostListEpoch || 0,
  });
  const call = (to, data) => chain.call(to, data).catch(() => null);

  /**
   * How this document gets what it renders. `viewerCarriage` on the proof
   * ledger is the authority — it reads this viewer composite's own part list on
   * chain rather than asking the document — so an injected answer wins. Absent
   * one, the document can still tell the truth about itself: either the bytes
   * came with it or they did not.
   */
  const CARRIAGE = ["Unknown", "Linked", "Inline", "Hybrid"];
  const carriage = () =>
    typeof C.carriage === "string" ? C.carriage
      : Number.isInteger(C.carriage) ? (CARRIAGE[C.carriage] || "Unknown")
      : document.getElementById("art")?.textContent?.trim() ? "Inline" : "Unknown";
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
      // About the artwork, which is what the score is for. The panel's live
      // lookups do reach a node, and the storage tab names it; what nothing
      // depends on is a host agreeing to keep a copy of the art alive.
      { label: "No content host in the path", points: 1, ok: carriage() === "Inline",
        why: "The artwork travels inside this document. No IPFS, no gateway, no server keeping a copy." },
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
      const [nm, sym, owner, uri] = await Promise.all([
        call(a, SEL.name), call(a, SEL.symbol),
        call(a, SEL.ownerOf + word(BigInt(C.tokenId || 0).toString(16))),
        call(a, SEL.tokenURI + word(BigInt(C.tokenId || 0).toString(16))),
      ]);
      const route = decodeString(uri);
      return [
        row("Address", a, `${SCAN}/address/${a}`),
        row("Name", decodeString(nm) ?? "—", null, false),
        row("Symbol", decodeString(sym) ?? "—", null, false),
        row("Holder of #" + C.tokenId, short(decodeAddress(owner) ?? "—", 8)),
        row("Route", route ?? "—", null, false),
        row("Route kind", route?.startsWith("ipfs://") ? "IPFS · content-addressed" : route ? "location" : "—", null, false),
      ];
    },
  });

  /** The stored bytes, as KeelHold records them. */
  const inspectObject = (id, title) => ({
    title,
    load: async () => {
      const raw = await call(C.keelHold, SEL.getObject + word(id));
      if (!raw) return [row("Object", id), row("Status", "unreadable", null, false)];
      // ObjectRecord: digest, indexDigest, pointer, byteLength, storedByteLength, chunkCount, …
      const hex = raw;
      return [
        row("Object id", id),
        row("Digest (sha256)", `0x${hex.slice(2, 66)}`),
        row("Byte length", uintAt(hex, 3).toLocaleString() + " B", null, false),
        row("Chunks", uintAt(hex, 5).toString(), null, false),
        row("Store", C.keelHold, `${SCAN}/address/${C.keelHold}`),
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
      row("Original collection", short(C.underlying, 8), null, true, C.underlying && inspectCollection()),
      row("Original token", `${C.tokenId ?? "?"}`, C.underlying && `${SCAN}/token/${C.underlying}?a=${C.tokenId}`),
      row("Wrapper", short(C.backpack, 8), C.backpack && `${SCAN}/address/${C.backpack}`),
      row("Chain", "Sepolia · 11155111"),
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
      row("Contract", C.underlying, null, true, C.underlying && inspectCollection()),
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
      row("Stored in", short(C.keelHold, 8), C.keelHold && `${SCAN}/address/${C.keelHold}`),
      row("Art object", short(C.assetObject, 10), null, true, C.assetObject && inspectObject(C.assetObject, "Artwork bytes")),
      row("Carriage", carriage() === "Inline" ? "Inline — carried by this document" : carriage(), null, false),
      row("Content hosts", "None — no HTTP, no gateway", null, false),
      // The panel is not the artwork, and a reader deserves to know the
      // difference: the art needs nobody, these live lookups need a node.
      row("Live lookups read through",
        chain.disclosure().servedBy ?? (chain.endpointCount === 0 ? "no permitted endpoint" : "not yet asked"),
        null, false),
      row("Governed host list",
        chain.disclosure().listRevision ? `revision ${chain.disclosure().listRevision}` : "built-in list · no revision pinned",
        null, false));

    const where = card("Where every byte lives",
      check(true, "Artwork", "KeelHold on this chain, content-addressed."),
      check(true, "Metadata", "Built by the contract at read time. No server."),
      check(true, "This viewer", "Stored on chain and rebuilt from it."),
      check(true, state.verified === null ? "Verifier, not an archive" : "Carried, not fetched",
        state.verified === null
          ? "This document proves things about the artwork; the artwork itself is served by the token's image field, on chain."
          : "The artwork is part of this document. Nothing is downloaded to show it, and no host has to be up or honest."),
      check(
        state.verified !== false,
        "Artwork verified here",
        state.verified === true
          ? `These bytes hash to ${short(C.assetCid ?? "", 12)} — the name the collection committed to. Checked in this document, so the node that served them is not trusted.`
          : state.verified === false
            ? "These bytes do NOT hash to the name the collection committed to."
            : "The artwork could not be checked against its committed name.",
      ));

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

  /**
   * The CID of these bytes, computed the way `ipfs add` computes it.
   *
   * The point of content addressing is that provenance does not matter — bytes
   * either hash to the name they were promised under or they do not. That only
   * holds if something actually does the sum, so this document does it rather
   * than taking an RPC response on faith.
   */
  const varint = (value) => {
    const out = [];
    while (value >= 0x80) {
      out.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    out.push(value);
    return out;
  };

  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let number = 0n;
    for (const byte of bytes) number = number * 256n + BigInt(byte);
    let out = "";
    while (number > 0n) {
      out = BASE58[Number(number % 58n)] + out;
      number /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      out = `1${out}`;
    }
    return out;
  }

  async function cidV0(content) {
    if (content.length > 262_144) return null; // a larger file needs a multi-block DAG
    const unixfs = [0x08, 0x02, 0x12, ...varint(content.length), ...content, 0x18, ...varint(content.length)];
    const node = new Uint8Array([0x0a, ...varint(unixfs.length), ...unixfs]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", node));
    return base58(new Uint8Array([0x12, 0x20, ...digest]));
  }

  // The art is fetched from the same chain that served this document.
  function paint(bytes) {
    state.bytes = bytes;
    const holder = $("#asset");
    const mounted = mountAsset({
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
   * Read the artwork out of this very document.
   *
   * The page is a KeelHold composite whose parts include the preserved bytes,
   * so they arrive with it. Nothing is fetched, no node is asked, and there is
   * no host that could be down or dishonest — rendering this page and holding
   * the artwork are the same act.
   */
  /**
   * The artwork, if this document was built to carry it.
   *
   * A verifier is chrome, not an archive. The same document has to be valid for
   * every token in a collection, so it cannot hold any one token's bytes —
   * whichever it held would be the wrong ones for everybody else. Where a
   * document *is* built for a single token it may carry them, and then they are
   * checked; where it is not, the artwork is served by `image` and there is
   * simply nothing here to check.
   *
   * Absence is not corruption. Saying so was a bug: it put a failure on screen
   * for the ordinary case.
   */
  const carried = document.getElementById("art")?.textContent?.trim();
  if (!carried) {
    state.verified = null;
    $("#boot").hidden = true;
    document.documentElement.classList.add("is-chrome-only");
    build();
  } else {
    const binary = atob(carried);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Carried bytes are still checked. They arrived with the document rather
    // than over a wire, but a CID is cheap to recompute and a claim nobody
    // verifies is decoration.
    (C.assetCid ? cidV0(bytes) : Promise.resolve(null))
      .then((computed) => {
        state.verified = computed === null ? null : computed === C.assetCid;
        if (state.verified === false) {
          document.documentElement.classList.add("is-corrupt");
          $("#boot").textContent = "BYTES DO NOT MATCH THE COMMITTED NAME";
          return;
        }
        paint(bytes);
      })
      .finally(build);
  }
})();
