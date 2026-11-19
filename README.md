# Arisan Rahasia — Private Arisan (ROSCA) on Tari Ootle

A rotating savings circle (*arisan*) as a Tari Ootle template: members contribute a
fixed amount of TARI every round into a shared vault, and each round pays the whole
pot to one member — until everyone has been paid exactly once.

The payout rotation is **sealed**: before the first round, the admin commits one
SHA-256 hash per round, `sha256(winner_public_key || salt)`. The order cannot be
changed after the circle starts, and only the current round's winner is ever
revealed — after all members have contributed.

## Layout

- `template/` — the Rust Ootle template (`ArisanCircle`), built with
  `tari_template_lib 0.41`.
- `tests/` — in-process engine tests using `tari_template_test_tooling 0.54`.
  No network or node required.
- `app/` — a walletless browser demo that mirrors the template's rules step
  for step (see below).
- `docs/` — [MECHANISM.md](docs/MECHANISM.md): the commit–reveal mechanism,
  roles, method ↔ demo mapping, and honest limits.

## Demo (walletless simulation)

`app/` is a static web app (plain HTML/CSS/JS, no build step) that simulates
one full circle — Ibu Sari's RT arisan in Jakarta: 10 members × 200 TARI per
round (the story's Rp200.000/month) — from `create_circle` to `close_circle`,
including the sealed commitment list, per-round reveals verified against the
commitments, and a "Try to break it" panel that shows the template's own
rejection messages. It is clearly labelled as a **simulation**: no wallet, no
live on-chain transactions.

Run it by opening `app/index.html` in a browser, or serve the folder:

```sh
cd app && python3 -m http.server 8000   # then visit http://localhost:8000
```

The demo is plain static files with no build step, so it can be hosted as-is on
any static host (e.g. GitHub Pages serving the `app/` folder).

## Live on Esmeralda

Template address: *(to be filled in after publishing — see the project's
publish runbook; the walletless demo above is the simulation of this template)*

Demo parity test (the JS simulation walked through the template's lifecycle
and rejection paths):

```sh
node app/simulation.test.mjs
```

## Template API

| Method | Who | What it does |
| --- | --- | --- |
| `create_circle(members, contribution)` | creator (becomes admin) | Creates a circle; rounds = number of members |
| `seal_draw(commitments)` | admin | Seals one SHA-256 commitment per round; activates the circle |
| `contribute(bucket)` | members | Contributes exactly the round amount, once per round |
| `reveal_winner(winner, salt)` | admin | Reveals this round's winner, verified against the sealed commitment |
| `payout()` | revealed winner | Claims the whole pot as a bucket |
| `close_circle()` | admin | Closes the circle after everyone has been paid |
| views | anyone | `admin`, `members`, `contribution_amount`, `round`, `total_rounds`, `phase`, `current_winner`, `paid`, `has_contributed`, `pot_balance` |

## Run the tests

```sh
cd tests
cargo test
```

## Honest limits

- The admin (treasurer) generates the rotation and salts off-chain; the on-chain
  commitments guarantee the order cannot be *changed* after sealing, but the
  admin does know the order. Fully trustless draws are future work.
- Vault balances are public, as with other Ootle vaults. What stays hidden is
  the payout order and each round's winner until their turn.
- The demo in `app/` is a simulation of the template flow, not a live
  deployment. See [docs/MECHANISM.md](docs/MECHANISM.md) for details.

## License

MIT — see [LICENSE](LICENSE).
