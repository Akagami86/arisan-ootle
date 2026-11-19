// Parity test for the walletless demo simulation (app/arisan.js).
//
// Run with:  node app/simulation.test.mjs
//
// The demo engine mirrors the Rust template in template/src/lib.rs rule for
// rule; this test walks the same scenarios the engine tests cover there —
// a full 10-member lifecycle plus the rejection paths — against the JS
// simulation, so the demo cannot silently drift from the template's logic.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sha256Hex, utf8, ArisanCircleSim } = require("./arisan.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}
function rejects(name, fn, message) {
  check(name, () => {
    assert.throws(fn, (err) => err.message === message, `expected rejection: ${message}`);
  });
}

// --- SHA-256 known-answer vectors (FIPS 180-4 examples) -------------------
check("sha256 of empty string", () => {
  assert.equal(
    sha256Hex(utf8("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});
check("sha256 of 'abc'", () => {
  assert.equal(
    sha256Hex(utf8("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});
check("sha256 of 56-byte FIPS message (two blocks)", () => {
  assert.equal(
    sha256Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
});

// --- The demo circle: Ibu Sari's RT arisan, 10 members x 200 TARI ---------
const NAMES = [
  "Ibu Sari", "Ibu Ratna", "Ibu Dewi", "Ibu Ani", "Ibu Sri",
  "Ibu Rina", "Ibu Maya", "Ibu Fitri", "Ibu Nur", "Ibu Tuti",
];
const CONTRIBUTION = 200;
const START = 2000; // exactly 10 rounds of contributions

function newCircle() {
  const sim = new ArisanCircleSim();
  sim.createCircle(NAMES, CONTRIBUTION, START);
  return sim;
}

// Deterministic draw for tests: order + salts injected at seal time.
const ORDER = [3, 0, 7, 1, 9, 2, 5, 8, 4, 6];
const SALTS = ORDER.map((_, i) => (i + 1).toString(16).padStart(32, "0"));

check("create_circle validations mirror the template", () => {
  const one = new ArisanCircleSim();
  assert.throws(() => one.createCircle(["Ibu Sari"], 200, START),
    /An arisan circle needs at least 2 members/);
  const zero = new ArisanCircleSim();
  assert.throws(() => zero.createCircle(NAMES, 0, START),
    /The per-round contribution must be greater than zero/);
  const dup = new ArisanCircleSim();
  assert.throws(() => dup.createCircle(["Ibu Sari", "Ibu Sari"], 200, START),
    /Duplicate member in the member list/);
});

const sim = newCircle();
check("after create: Registration, round 0, 10 rounds total", () => {
  assert.equal(sim.phase, "Registration");
  assert.equal(sim.round, 0);
  assert.equal(sim.totalRounds(), 10);
  assert.equal(sim.potBalance(), 0);
});

rejects("contribute before seal is rejected (circle not active)",
  () => sim.contribute(1), "The circle is not active");
rejects("seal by a non-admin is rejected",
  () => sim.sealDraw(1, { order: ORDER, saltsHex: SALTS }),
  "Only the circle admin can seal the draw");

sim.sealDraw(0, { order: ORDER, saltsHex: SALTS });
check("after seal: Active, round 1, 10 commitments of 64 hex chars", () => {
  assert.equal(sim.phase, "Active");
  assert.equal(sim.round, 1);
  assert.equal(sim.commitments.length, 10);
  for (const c of sim.commitments) assert.match(c, /^[0-9a-f]{64}$/);
});
rejects("sealing twice is rejected",
  () => sim.sealDraw(0, { order: ORDER, saltsHex: SALTS }),
  "The draw can only be sealed once, before the circle starts");

// --- Round 1 with every rejection path ------------------------------------
rejects("non-member contribution is rejected",
  () => sim.contribute("Ibu Orang Luar"), "Only circle members can contribute");
rejects("wrong contribution amount is rejected",
  () => sim.contribute(1, 150), "The contribution must be exactly the agreed round amount");

sim.contribute(1);
rejects("contributing twice in one round is rejected",
  () => sim.contribute(1), "This member has already contributed in the current round");
rejects("reveal before everyone contributed is rejected", () => {
  const s = sim.adminSecretForCurrentRound();
  sim.revealWinner(0, s.winner, s.saltHex);
}, "All members must contribute before the winner is revealed");
rejects("payout before reveal is rejected",
  () => sim.payout(ORDER[0]), "The winner of the current round has not been revealed yet");

for (let i = 0; i < 10; i++) if (!sim.hasContributed(i)) sim.contribute(i);
check("after everyone contributes: pot is 10 x 200 = 2000 TARI", () => {
  assert.equal(sim.potBalance(), 2000);
  assert.equal(sim.allContributed(), true);
});

rejects("tampered reveal (different winner, real salt) fails the commitment check", () => {
  const s = sim.adminSecretForCurrentRound();
  const other = (s.winner + 1) % 10;
  sim.revealWinner(0, other, s.saltHex);
}, "The reveal does not match the sealed commitment for this round");
rejects("reveal with the wrong salt fails the commitment check", () => {
  const s = sim.adminSecretForCurrentRound();
  sim.revealWinner(0, s.winner, "ff".repeat(16));
}, "The reveal does not match the sealed commitment for this round");

const secret1 = sim.adminSecretForCurrentRound();
check("commitment verification: sha256(winner_key || salt) == sealed commitment", () => {
  assert.equal(sim.verifyReveal(secret1.winner, secret1.saltHex), sim.commitmentForRound(1));
  assert.equal(secret1.winner, ORDER[0]);
});
sim.revealWinner(0, secret1.winner, secret1.saltHex);
rejects("claiming the payout as a non-winner is rejected",
  () => sim.payout((secret1.winner + 1) % 10), "Only the revealed winner can claim the payout");

const before = sim.balances[secret1.winner];
const paidOut = sim.payout(secret1.winner);
check("payout moves the whole pot to the winner and advances the round", () => {
  assert.equal(paidOut, 2000);
  assert.equal(sim.balances[secret1.winner], before + 2000);
  assert.equal(sim.potBalance(), 0);
  assert.equal(sim.round, 2);
  assert.deepEqual(sim.paid, [ORDER[0]]);
});
rejects("double claim is rejected (no winner revealed in the new round)",
  () => sim.payout(ORDER[0]), "The winner of the current round has not been revealed yet");
rejects("closing before completion is rejected",
  () => sim.closeCircle(0), "The circle can only be closed once every member has been paid");

// --- Rounds 2..10 ----------------------------------------------------------
for (let round = 2; round <= 10; round++) {
  for (let i = 0; i < 10; i++) sim.contribute(i);
  const s = sim.adminSecretForCurrentRound();
  assert.equal(s.winner, ORDER[round - 1]);
  sim.revealWinner(0, s.winner, s.saltHex);
  sim.payout(s.winner);
}
check("after round 10: phase Completed, everyone paid exactly once", () => {
  assert.equal(sim.phase, "Completed");
  assert.equal(sim.paid.length, 10);
  assert.deepEqual([...sim.paid].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
check("a fair arisan: every balance is back to exactly the start", () => {
  for (const b of sim.balances) assert.equal(b, START);
  assert.equal(sim.potBalance(), 0);
});
rejects("closing by a non-admin is rejected",
  () => sim.closeCircle(1), "Only the circle admin can close the circle");
sim.closeCircle(0);
check("circle closes", () => assert.equal(sim.phase, "Closed"));

console.log(`\n${passed} checks passed, 0 failed — demo simulation matches the template lifecycle.`);
