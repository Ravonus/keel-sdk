"""Keel one-pager for zkVerify outreach — Ethereum <-> Tezos.

Build:  packages/tezos/.venv/bin/python docs/outreach/build_pdf.py
(reportlab lives in that venv; the system python does not have it.)
"""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

W, H = LETTER
INK    = colors.HexColor("#101418")
MUTED  = colors.HexColor("#5B6672")
RULE   = colors.HexColor("#D8DEE5")
ACCENT = colors.HexColor("#0F7B6C")
ETH    = colors.HexColor("#3C5FCC")
TEZ    = colors.HexColor("#0E7DD6")
WARN   = colors.HexColor("#B25E09")
PAPER  = colors.HexColor("#FBFCFD")

OUT = "/Users/ravonus/dev/keel-sdk/docs/outreach/keel-zkverify.pdf"
M = 0.85 * inch


def page_bg(c):
    c.setFillColor(PAPER); c.rect(0, 0, W, H, fill=1, stroke=0)

def h1(c, y, text, size=26):
    c.setFillColor(INK); c.setFont("Helvetica-Bold", size); c.drawString(M, y, text)
    return y - size - 6

def h2(c, y, text):
    c.setFillColor(ACCENT); c.setFont("Helvetica-Bold", 8.5); c.drawString(M, y, text.upper())
    c.setStrokeColor(RULE); c.setLineWidth(0.6); c.line(M, y - 6, W - M, y - 6)
    return y - 22

def body(c, y, text, size=10.2, lead=15, color=INK, indent=0):
    c.setFillColor(color); c.setFont("Helvetica", size)
    for line in simpleSplit(text, "Helvetica", size, W - 2*M - indent):
        c.drawString(M + indent, y, line); y -= lead
    return y

def bullet(c, y, label, text, lead=14.5):
    c.setFillColor(ACCENT); c.setFont("Helvetica-Bold", 10.2); c.drawString(M, y, "—")
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 10.2); c.drawString(M + 14, y, label)
    wlab = c.stringWidth(label, "Helvetica-Bold", 10.2)
    c.setFont("Helvetica", 10.2)
    lines = simpleSplit(text, "Helvetica", 10.2, W - M - (M + 14 + wlab + 5))
    if lines:
        c.drawString(M + 14 + wlab + 5, y, lines[0]); y -= lead
        for ln in simpleSplit(" ".join(lines[1:]), "Helvetica", 10.2, W - 2*M - 14):
            c.drawString(M + 14, y, ln); y -= lead
    return y - 3

def footer(c, n):
    c.setFillColor(MUTED); c.setFont("Helvetica", 7.6)
    c.drawString(M, 0.55*inch, "Keel · Ethereum <-> Tezos storage verification")
    c.drawRightString(W - M, 0.55*inch, f"{n}")

c = canvas.Canvas(OUT, pagesize=LETTER)

# ---------------------------------------------------------------- page 1
page_bg(c)
c.setFillColor(ACCENT); c.rect(M, H - M + 8, 46, 3.5, fill=1, stroke=0)
y = H - M - 26
y = h1(c, y, "Ethereum and Tezos, verifying")
y = h1(c, y + 4, "each other. No bridge.")
c.setFillColor(MUTED); c.setFont("Helvetica", 12.5)
c.drawString(M, y, "Art preserved as provable bytes — not a token, not a pointer, not a promise.")
y -= 32

y = body(c, y,
    "Almost everything built between chains moves tokens through a bridge you have to trust. Keel "
    "does the opposite: it makes the artwork itself provable, and lets each chain check the other's "
    "proof on its own — no oracle, no attestor set, nobody in the middle.", size=11.4, lead=16.5)
y -= 26

# --- diagram: ETH <-> TEZ ------------------------------------------------
dx, dy = M, y - 176
c.setStrokeColor(RULE); c.setLineWidth(0.8)
c.roundRect(dx, dy, W - 2*M, 168, 8, fill=0, stroke=1)

lx, rx, my = dx + 118, dx + W - 2*M - 118, dy + 104
for x, name, col in ((lx, "ETHEREUM", ETH), (rx, "TEZOS", TEZ)):
    c.setFillColor(col); c.circle(x, my, 34, fill=1, stroke=0)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 8.5)
    c.drawCentredString(x, my - 3, name)

c.setStrokeColor(ACCENT); c.setLineWidth(1.6)
c.line(lx + 40, my + 11, rx - 40, my + 11)
c.line(lx + 40, my - 11, rx - 40, my - 11)
for xx, yy, d in ((rx - 40, my + 11, -1), (lx + 40, my - 11, 1)):
    c.setFillColor(ACCENT)
    p = c.beginPath(); p.moveTo(xx, yy); p.lineTo(xx + 8*d, yy + 4); p.lineTo(xx + 8*d, yy - 4); p.close()
    c.drawPath(p, fill=1, stroke=0)

c.setFillColor(MUTED); c.setFont("Helvetica", 8.2)
c.drawCentredString((lx+rx)/2, my + 18, "Tezos consensus verified in Solidity  ~318k gas")
c.drawCentredString((lx+rx)/2, my - 26, "Ethereum state verified in Michelson  no proof needed")

c.setFillColor(INK); c.setFont("Helvetica-Bold", 9)
c.drawCentredString((lx+rx)/2, dy + 46, "The same artwork exists on both. Independently checkable on each.")
c.setFillColor(MUTED); c.setFont("Helvetica-Oblique", 8.2)
c.drawCentredString((lx+rx)/2, dy + 30, "If one chain fails, the other still proves it. Bitcoin works too, as a third copy.")
y = dy - 26

y = h2(c, y, "Why this is different")
y = bullet(c, y, "Not token-based. ",
    "The proof is about bytes, not ownership. Attach it to an NFT, or keep it standalone as a backup "
    "that outlives the token, the marketplace, and the company that minted it.")
y = bullet(c, y, "Not a bridge. ",
    "Nothing is wrapped or moved. Each chain confirms the content itself, so there is no bridge to hack "
    "and no failure that propagates.")
y = bullet(c, y, "Not maximalist. ",
    "Ethereum and Tezos are both first-class. The goal is the same work living in both places at once, "
    "not an argument about which chain wins.")
footer(c, 1); c.showPage()

# ---------------------------------------------------------------- page 2
page_bg(c)
y = H - M - 8
y = h1(c, y, "Both directions, measured", size=20)
y -= 4
y = body(c, y, "Against live mainnet data, not simulations.", size=10.2, color=MUTED); y -= 16

rows = [
    ("Tezos -> Ethereum", "Solidity verifies Tezos BLS consensus signatures natively, using the "
     "BLS12-381 precompiles added in Pectra.", "~318k gas · no prover"),
    ("Ethereum -> Tezos", "Michelson walks Ethereum's Merkle-Patricia state trie directly, using "
     "native KECCAK. Verified against a real mainnet storage proof.", "no prover"),
    ("Tezos quorum -> Ethereum", "77 signatures across three schemes, proven in a zkVM because "
     "35M gas of Ed25519 will not fit in a block.", "20.6M cycles"),
    ("Bitcoin -> both", "A real ordinal inscription verified on Ethereum and Tezos, reaching the "
     "identical anchor root by independent means.", "third copy"),
]
c.setStrokeColor(RULE); c.setLineWidth(0.6)
for label, desc, metric in rows:
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 10); c.drawString(M, y, label)
    c.setFillColor(ACCENT); c.setFont("Helvetica-Bold", 8.6); c.drawRightString(W - M, y, metric)
    y -= 14
    c.setFillColor(MUTED); c.setFont("Helvetica", 9.2)
    for ln in simpleSplit(desc, "Helvetica", 9.2, W - 2*M):
        c.drawString(M, y, ln); y -= 11
    y -= 5; c.line(M, y, W - M, y); y -= 15

y -= 4
y = h2(c, y, "The economics of one hard case")
y = body(c, y,
    "Three of those four need no proof at all — each chain simply does the arithmetic. The exception is "
    "Tezos consensus on Ethereum: about half of Tezos validators sign with Ed25519 and half with P-256, "
    "and the EVM has a precompile for neither. Checking it directly would cost roughly 35 million gas, "
    "more than an Ethereum block holds.", lead=15.5)
y -= 8
y = body(c, y,
    "Proved instead, it verifies for about 300 thousand. That gap is the entire economic case for a "
    "verification layer, and it is why zkVerify's aggregation is the cheapest route we found: a Merkle "
    "check rather than a pairing check, amortised across everyone else's proofs.", lead=15.5)
footer(c, 2); c.showPage()

# ---------------------------------------------------------------- page 3
page_bg(c)
y = H - M - 8
y = h1(c, y, "Where zkVerify fits", size=20)
y -= 10

c.setFillColor(colors.HexColor("#FFF8EE")); c.setStrokeColor(WARN); c.setLineWidth(0.8)
box_h = 88
c.roundRect(M, y - box_h + 12, W - 2*M, box_h, 6, fill=1, stroke=1)
c.setFillColor(WARN); c.setFont("Helvetica-Bold", 9)
c.drawString(M + 14, y - 6, "STATUS: INTEGRATION COMPLETE, PROOF BUILT, NOT YET SUBMITTED")
c.setFillColor(INK); c.setFont("Helvetica", 9.6)
ty = y - 22
for line in simpleSplit(
    "Our verification route calls zkVerify's live aggregation contract on Sepolia, with the leaf digest "
    "transcribed from zkv-attestation-contracts and confirmed ABI-compatible against the deployed proxy. "
    "A proof is built and formatted for submission; the Volta account is still short of the fee, so no "
    "receipt exists yet. Until one does, we describe this as built and wired rather than proven in "
    "production.", "Helvetica", 9.6, W - 2*M - 28):
    c.drawString(M + 14, ty, line); ty -= 13
y = y - box_h - 16

y = h2(c, y, "What zkVerify verifies for us")
y = body(c, y,
    "Anchor proofs on the Ethereum side. When an artwork is anchored, a proof establishes that a "
    "foreign chain really holds those bytes, and something on Ethereum has to check it. That check is "
    "the route zkVerify serves: our contract reconstructs the statement digest, then asks zkVerify's "
    "aggregation contract whether that statement sits in a published aggregation.", lead=15.5)
y -= 8
y = body(c, y,
    "On the Tezos side the arithmetic is done directly in Michelson, which has native BLS12-381 pairing "
    "and KECCAK. Two destinations, two verification routes, one architecture — the proof-checking layer "
    "is deliberately pluggable so each chain uses whatever is cheapest there.", lead=15.5)
y -= 16

y = h2(c, y, "Why aggregation is the right shape for this")
y = body(c, y,
    "Verifying a proof outright costs a pairing check. Verifying its membership in an aggregation costs "
    "a Merkle check, with the expensive part amortised across every other proof in the batch. For a "
    "workload like ours that difference compounds, and the measurements say why: in our Bitcoin proof the "
    "chain-of-headers walk is 5,859 cycles per header and everything else is a flat 140k, so the "
    "expensive part is shared by every artwork proven against the same segment. Batching them into one "
    "proof is designed, not yet built.", lead=15.5)
y -= 8
y = body(c, y,
    "Latency is irrelevant to us. These are permanent records, not trades. Nobody is waiting on a "
    "confirmation, so batching costs us nothing and saves us the per-proof price.", lead=15.5)
y -= 16

y = h2(c, y, "Why the story travels")
y = body(c, y,
    "Verification layers are always explained through rollups and throughput. This is a different shape: "
    "cultural preservation, where the value is that a work can still be proven real long after whoever "
    "minted it is gone. Same technology, an audience that has never heard of it.", lead=15.5)

y -= 24
c.setStrokeColor(RULE); c.setLineWidth(0.6); c.line(M, y, W - M, y); y -= 18
body(c, y, "Every figure here is measured against mainnet or explicitly marked as not yet done.",
     size=9, color=MUTED, lead=13)
footer(c, 3)
c.save()
print("wrote", OUT)
