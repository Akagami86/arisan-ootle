// Arisan Rahasia — walletless demo simulation engine.
//
// This file mirrors, rule for rule, the behaviour of the Rust Ootle template
// in ../template/src/lib.rs (ArisanCircle). It is NOT connected to any chain:
// it runs the same state machine in the browser so visitors can walk the full
// lifecycle of a circle and see exactly which actions the template accepts
// and which it rejects (with the template's own assertion messages).
//
// The commitment scheme is identical to the template's:
//   commitment(round) = sha256(winner_public_key_bytes || salt)
// computed here with a small dependency-free SHA-256 (FIPS 180-4), equivalent
// to the engine intrinsic `hash_sha256_parts` used on-chain.
//
// Loaded as a classic script: exposes `window.ArisanSim` in the browser and
// `module.exports` under Node (for the parity test in simulation.test.mjs).

(function (global) {
  "use strict";

  // ---------------------------------------------------------------- SHA-256
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // sha256Hex(Uint8Array) -> 64-char lowercase hex string.
  function sha256Hex(input) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    var bitLen = input.length * 8;
    var paddedLen = Math.ceil((input.length + 9) / 64) * 64;
    var msg = new Uint8Array(paddedLen);
    msg.set(input);
    msg[input.length] = 0x80;
    var dv = new DataView(msg.buffer);
    dv.setUint32(paddedLen - 4, bitLen >>> 0);
    dv.setUint32(paddedLen - 8, Math.floor(bitLen / 4294967296));

    var w = new Uint32Array(64);
    var block, t, a, b, c, d, e, f, g, h, s0, s1, S0, S1, ch, maj, temp1, temp2;
    for (block = 0; block < paddedLen; block += 64) {
      for (t = 0; t < 16; t++) w[t] = dv.getUint32(block + t * 4);
      for (t = 16; t < 64; t++) {
        s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      a = h0; b = h1; c = h2; d = h3; e = h4; f = h5; g = h6; h = h7;
      for (t = 0; t < 64; t++) {
        S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        ch = (e & f) ^ (~e & g);
        temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
        S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        maj = (a & b) ^ (a & c) ^ (b & c);
        temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(function (x) { return (x >>> 0).toString(16).padStart(8, "0"); })
      .join("");
  }

  // ------------------------------------------------------------- byte utils
  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(out);
    } else {
      for (var i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  function shuffledIndices(n) {
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    for (var j = n - 1; j > 0; j--) {
      var r = Math.floor(Math.random() * (j + 1));
      var tmp = idx[j]; idx[j] = idx[r]; idx[r] = tmp;
    }
    return idx;
  }

  // A demo identity: a 32-byte "public key" derived deterministically from the
  // member's name (on-chain this would be the account owner's Ristretto key).
  function demoPublicKey(name) {
    return sha256Hex(utf8("arisan-rahasia/demo-member/" + name));
  }

  // ------------------------------------------------------------- the circle
  // Error messages intentionally match template/src/lib.rs assertion strings.
  function ArisanCircleSim() {
    this.created = false;
    this.admin = null;          // member index of the admin (the creator)
    this.adminName = null;
    this.members = [];          // [{ name, keyHex }]
    this.contribution = 0;      // TARI per member per round
    this.vault = 0;             // TARI held in the circle vault
    this.phase = "Registration"; // Registration | Active | Completed | Closed
    this.round = 0;             // 1-based once active, 0 during registration
    this.commitments = [];      // one 64-hex SHA-256 per round
    this.contributed = [];      // per-member bool for the current round
    this.currentWinner = null;  // member index or null
    this.paid = [];             // member indices, in payout order
    this.balances = [];         // demo wallet balances (TARI) per member
    this._secrets = null;       // admin's off-chain notebook: { order, saltsHex }
    this.revealed = [];         // per-round reveal record { round, winner, saltHex }
  }

  // --- create_circle(members, contribution); the creator becomes the admin.
  // Demo convention: the creator (Ibu Sari) is also member #0, which the
  // template permits — the admin key simply has to match the signer.
  ArisanCircleSim.prototype.createCircle = function (memberNames, contribution, startBalance) {
    if (this.created) throw new Error("This demo circle has already been created");
    if (!Array.isArray(memberNames) || memberNames.length < 2) {
      throw new Error("An arisan circle needs at least 2 members");
    }
    if (!(contribution > 0)) {
      throw new Error("The per-round contribution must be greater than zero");
    }
    var keys = memberNames.map(demoPublicKey);
    for (var i = 0; i < keys.length; i++) {
      if (keys.indexOf(keys[i]) !== i) throw new Error("Duplicate member in the member list");
    }
    this.members = memberNames.map(function (name, idx) {
      return { name: name, keyHex: keys[idx] };
    });
    this.admin = 0;
    this.adminName = memberNames[0];
    this.contribution = contribution;
    this.balances = memberNames.map(function () { return startBalance; });
    this.created = true;
    return this;
  };

  // --- seal_draw(commitments) — admin only, once, before the first round.
  // The demo generates the admin's secret rotation + salts off-chain (exactly
  // like the real treasurer would) unless a test injects them.
  ArisanCircleSim.prototype.sealDraw = function (actor, injected) {
    if (this.phase !== "Registration") {
      throw new Error("The draw can only be sealed once, before the circle starts");
    }
    if (actor !== this.admin) throw new Error("Only the circle admin can seal the draw");
    var n = this.members.length;
    var order, saltsHex;
    if (injected && injected.order && injected.saltsHex) {
      order = injected.order.slice();
      saltsHex = injected.saltsHex.slice();
    } else {
      order = shuffledIndices(n);
      saltsHex = [];
      for (var i = 0; i < n; i++) saltsHex.push(bytesToHex(randomBytes(16)));
    }
    if (order.length !== n || saltsHex.length !== n) {
      throw new Error("Exactly one commitment per round is required");
    }
    var commitments = [];
    for (var r = 0; r < n; r++) {
      var winnerKey = hexToBytes(this.members[order[r]].keyHex);
      var digest = sha256Hex(concatBytes(winnerKey, hexToBytes(saltsHex[r])));
      if (digest.length !== 64) throw new Error("Each commitment must be a 32-byte SHA-256 hash");
      commitments.push(digest);
    }
    this._secrets = { order: order, saltsHex: saltsHex };
    this.commitments = commitments;
    this.contributed = this.members.map(function () { return false; });
    this.round = 1;
    this.phase = "Active";
    return this.commitments;
  };

  // --- contribute(bucket) — members only, exactly the round amount, once.
  // `member` is a member index, or -1 / an unknown name for a non-member.
  ArisanCircleSim.prototype.contribute = function (member, amount) {
    if (this.phase !== "Active") throw new Error("The circle is not active");
    var index = typeof member === "number" ? member : this.members.findIndex(function (m) { return m.name === member; });
    if (index < 0 || index >= this.members.length) {
      throw new Error("Only circle members can contribute");
    }
    if (this.contributed[index]) {
      throw new Error("This member has already contributed in the current round");
    }
    var amt = amount === undefined ? this.contribution : amount;
    if (amt !== this.contribution) {
      throw new Error("The contribution must be exactly the agreed round amount");
    }
    if (this.balances[index] < amt) {
      // Demo-wallet guard only; on-chain the account itself enforces this.
      throw new Error("Insufficient demo wallet balance");
    }
    this.balances[index] -= amt;
    this.vault += amt;
    this.contributed[index] = true;
    return index;
  };

  // The admin's off-chain knowledge for the current round (never rendered as
  // a list by the UI — only this round's entry is used, at reveal time).
  ArisanCircleSim.prototype.adminSecretForCurrentRound = function () {
    if (!this._secrets || this.phase !== "Active") return null;
    var r = this.round - 1;
    return { winner: this._secrets.order[r], saltHex: this._secrets.saltsHex[r] };
  };

  // --- reveal_winner(winner, salt) — admin only, after everyone contributed,
  // verified against the sealed commitment for this round.
  ArisanCircleSim.prototype.revealWinner = function (actor, winner, saltHex) {
    if (this.phase !== "Active") throw new Error("The circle is not active");
    if (actor !== this.admin) throw new Error("Only the circle admin can reveal the winner");
    if (this.currentWinner !== null) {
      throw new Error("The winner of the current round has already been revealed");
    }
    if (!this.contributed.every(function (c) { return c; })) {
      throw new Error("All members must contribute before the winner is revealed");
    }
    if (typeof winner !== "number" || winner < 0 || winner >= this.members.length) {
      throw new Error("The revealed winner is not a circle member");
    }
    if (this.paid.indexOf(winner) !== -1) {
      throw new Error("The revealed winner has already received a payout");
    }
    var digest = sha256Hex(concatBytes(hexToBytes(this.members[winner].keyHex), hexToBytes(saltHex)));
    if (digest !== this.commitments[this.round - 1]) {
      throw new Error("The reveal does not match the sealed commitment for this round");
    }
    this.currentWinner = winner;
    this.revealed.push({ round: this.round, winner: winner, saltHex: saltHex });
    return winner;
  };

  // --- payout() — only the revealed winner can claim the whole pot.
  ArisanCircleSim.prototype.payout = function (actor) {
    if (this.phase !== "Active") throw new Error("The circle is not active");
    if (this.currentWinner === null) {
      throw new Error("The winner of the current round has not been revealed yet");
    }
    if (actor !== this.currentWinner) {
      throw new Error("Only the revealed winner can claim the payout");
    }
    var amount = this.vault;
    this.balances[this.currentWinner] += amount;
    this.vault = 0;
    this.paid.push(this.currentWinner);
    this.currentWinner = null;
    if (this.paid.length === this.members.length) {
      this.phase = "Completed";
    } else {
      this.round += 1;
      this.contributed = this.members.map(function () { return false; });
    }
    return amount;
  };

  // --- close_circle() — admin only, once everyone has been paid.
  ArisanCircleSim.prototype.closeCircle = function (actor) {
    if (actor !== this.admin) throw new Error("Only the circle admin can close the circle");
    if (this.phase !== "Completed") {
      throw new Error("The circle can only be closed once every member has been paid");
    }
    if (this.vault !== 0) throw new Error("The circle vault is not empty");
    this.phase = "Closed";
  };

  // ------------------------------------------------------------------ views
  ArisanCircleSim.prototype.totalRounds = function () { return this.members.length; };
  ArisanCircleSim.prototype.potBalance = function () { return this.vault; };
  ArisanCircleSim.prototype.hasContributed = function (index) { return !!this.contributed[index]; };
  ArisanCircleSim.prototype.allContributed = function () {
    return this.contributed.length > 0 && this.contributed.every(function (c) { return c; });
  };
  ArisanCircleSim.prototype.commitmentForRound = function (round) {
    return this.commitments[round - 1] || null;
  };
  // Recompute a reveal digest so the UI can show the verification step.
  ArisanCircleSim.prototype.verifyReveal = function (winner, saltHex) {
    return sha256Hex(concatBytes(hexToBytes(this.members[winner].keyHex), hexToBytes(saltHex)));
  };

  var api = {
    sha256Hex: sha256Hex,
    utf8: utf8,
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    demoPublicKey: demoPublicKey,
    ArisanCircleSim: ArisanCircleSim
  };

  global.ArisanSim = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
