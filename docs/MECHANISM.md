# Arisan Rahasia — Mechanism

How the sealed-rotation arisan (ROSCA) works on Tari Ootle: the template, the
commit–reveal draw, the roles, and the honest limits.

- Template: `template/src/lib.rs` (`ArisanCircle`, built with `tari_template_lib 0.41`)
- Walletless demo: `app/` — a browser simulation that mirrors the template rule for rule
- Engine tests: `tests/` (`tari_template_test_tooling`, 22 tests, no network required)

---

## 1. The problem and the idea

An *arisan* is a rotating savings and credit association (ROSCA), used by more
than a billion people worldwide (arisan in Indonesia, *tanda*, *susu*, chit
funds, …). N members each contribute a fixed amount every round; each round,
one member receives the whole pot; after N rounds everyone has been paid
exactly once.

The social weak point is the **order**. If everyone knows whose turn is next,
members who are still waiting get pressured and members who just got paid get
chased for loans. Arisan Rahasia keeps the order **sealed**: it is fixed
up-front so it cannot be rigged later, but it is only ever revealed one winner
at a time — in the round that winner is actually paid.

## 2. Roles

| Role | Who in the story | On-chain identity | Powers |
| --- | --- | --- | --- |
| **Admin (treasurer)** | Ibu Sari, the RT arisan treasurer | The account that signs `create_circle` becomes the admin | Seals the draw, reveals each round's winner, closes the finished circle. In the demo she is also a member; the template allows the admin to be inside or outside the member list. |
| **Member** | The 10 arisan participants | Each member is an account owner public key (`RistrettoPublicKeyBytes`) | Contributes exactly the agreed amount, once per round. Only members can contribute. |
| **Winner (of a round)** | The member whose turn it is | The member revealed by `reveal_winner` for the current round | The only account that can call `payout` and claim the whole pot for that round. |

All permissions are enforced from the transaction signer
(`CallerContext::transaction_signer_public_key()`), not from parameters a
caller could spoof.

## 3. The commit–reveal draw

Before the first round, the admin decides a payout order off-chain and, for
each round `r`, picks a secret random **salt**. She then publishes one
commitment per round:

```
commitment(r) = sha256( winner_public_key_bytes(r) || salt(r) )
```

(On-chain this is the engine intrinsic `hash_sha256_parts`, exactly as in
`template/src/lib.rs`.)

Two properties of SHA-256 do the work:

- **Binding** — after the commitments are stored by `seal_draw`, the admin
  cannot change the order: any different winner or salt hashes to a different
  value and `reveal_winner` rejects it.
- **Hiding** — a 32-byte hash of a key plus a secret salt reveals nothing
  about who the winner is, so the order stays private while it is provably
  fixed.

Each round, after **all** members have contributed, the admin reveals exactly
one pair `(winner, salt)`. The template recomputes the hash and compares it
with the sealed commitment for that round before accepting the reveal. Salts
of future rounds are never disclosed, so later winners stay hidden.

### Flow

```
 ADMIN (off-chain)                     TEMPLATE (on-chain)
 -----------------                     -------------------
 decide order W1..WN
 pick salts S1..SN
        |
        |  create_circle(members, contribution)
        | ------------------------------------------>  phase = Registration
        |                                              admin = signer
        |  seal_draw([sha256(W1||S1), ..., sha256(WN||SN)])
        | ------------------------------------------>  commitments stored
        |                                              phase = Active, round = 1
        |
   for round r = 1..N:
        |    each member: contribute(bucket of exactly `contribution` TARI)
        | ------------------------------------------>  vault += contribution
        |                                              (once per member per round)
        |  reveal_winner(Wr, Sr)
        | ------------------------------------------>  check sha256(Wr||Sr)
        |                                              == commitment(r)  ?
        |                                              no  -> rejected
        |                                              yes -> winner revealed
        |    winner: payout()
        | ------------------------------------------>  whole vault -> winner
        |                                              round += 1 (or Completed)
        |
        |  close_circle()   (after round N)
        | ------------------------------------------>  phase = Closed
```

### Lifecycle (state machine)

```
                 create_circle        seal_draw
  (nothing) -----------------> Registration ---------> Active
                                                            |
                              rounds 1..N: contribute -> reveal -> payout
                                                            |
                                                last payout v
                                                        Completed
                                                            |  close_circle
                                                            v
                                                         Closed
```

Rules enforced by the template at every step (assertion messages in the demo
are the template's own):

- A circle needs at least 2 members, a contribution greater than zero, and no
  duplicate members.
- The draw can be sealed once, by the admin only, with exactly one 32-byte
  commitment per round.
- Contributions are members-only, in TARI, exactly the agreed amount, once
  per member per round.
- A winner can only be revealed by the admin, only after every member has
  contributed, only if they are a member who has not been paid yet, and only
  if the reveal matches the sealed commitment.
- Only the revealed winner can claim the payout; the whole pot moves at once.
- The circle can be closed by the admin only after everyone has been paid
  and the vault is empty.

## 4. Template methods ↔ demo actions

The demo in `app/` runs the same state machine in the browser
(`app/arisan.js`). It is a **simulation** — no wallet, no chain — but every
button below calls the equivalent template method under the same rules, and
the "Try to break it" panel demonstrates the rejections.

| Template method | Caller | Demo action |
| --- | --- | --- |
| `create_circle(members, contribution)` | creator → admin | "Create the circle" — 10 members, 200 TARI per round |
| `seal_draw(commitments)` | admin | "Seal the draw" — generates the secret rotation + salts off-chain (as the real treasurer would) and shows only the 10 commitment hashes |
| `contribute(bucket)` | member | One button per member (or "Everyone contributes") — 200 TARI into the vault |
| `reveal_winner(winner, salt)` | admin | "Reveal this round's winner" — the demo shows the winner, the salt, the recomputed hash and the sealed commitment side by side |
| `payout()` | revealed winner | "… claims the pot" — the whole vault moves to the winner |
| `close_circle()` | admin | "Close the circle" — available once everyone has been paid |
| views: `phase`, `round`, `total_rounds`, `pot_balance`, `has_contributed`, `paid`, `current_winner`, `commitments` | anyone | The status bar, member cards and sealed-draw list |

Parity is tested, not just claimed: `node app/simulation.test.mjs` walks the
JS simulation through the same scenarios the Rust engine tests cover
(full lifecycle, wrong amount, non-member, double contribution, early reveal,
tampered reveal, wrong salt, non-winner claim, double claim, early close)
and checks that a fair circle returns every wallet to its exact start.

Units in the demo: contributions and pots are **TARI** (the on-chain unit).
The story context is Ibu Sari's arisan at **Rp200.000 per member per month**,
a pot of **Rp2.000.000** per round; demo wallets start at 2.000 TARI, exactly
ten rounds of contributions.

## 5. Honest limits

- **The admin knows the order.** The treasurer generates the rotation and the
  salts off-chain. The commitments guarantee the order cannot be *changed*
  after sealing — they do not hide it from the admin herself. A fully
  trustless draw (e.g. threshold/VRF-based) is future work.
- **Vault balances are public**, as with other Ootle vaults. What stays
  hidden is the payout order and each round's winner until their turn.
- **The demo is a simulation.** Demo "public keys" are derived from member
  names, salts and balances live in the browser, and the demo's SHA-256 is a
  small dependency-free implementation used so the page works from any static
  host. On-chain, the template uses real account keys, real TARI buckets and
  the engine's `hash_sha256_parts` intrinsic; the 22 engine tests in `tests/`
  verify the same rules against the real template.
