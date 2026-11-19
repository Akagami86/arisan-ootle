// Arisan Rahasia — demo UI wiring.
// All state transitions go through ArisanSim.ArisanCircleSim (arisan.js),
// which mirrors the Rust template's rules. This file only renders and calls.

(function () {
  "use strict";

  var NAMES = [
    "Ibu Sari", "Ibu Ratna", "Ibu Dewi", "Ibu Ani", "Ibu Sri",
    "Ibu Rina", "Ibu Maya", "Ibu Fitri", "Ibu Nur", "Ibu Tuti"
  ];
  var CONTRIBUTION = 200;   // TARI per member per round (story: Rp200.000)
  var START_BALANCE = 2000; // TARI — exactly 10 rounds of contributions

  var sim = new ArisanSim.ArisanCircleSim();
  var started = false;
  var lastReveal = null; // { round, winner, saltHex, digest, commitment }

  var $ = function (id) { return document.getElementById(id); };
  var logEl = $("log");

  function fmt(n) { return n.toLocaleString("id-ID"); }
  function shortKey(hex) { return hex.slice(0, 10) + "…" + hex.slice(-6); }

  function log(msg, cls) {
    var li = document.createElement("li");
    li.textContent = msg;
    if (cls) li.className = cls;
    logEl.appendChild(li);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function ok(msg) { log("✓ " + msg, "ok"); }
  function err(action, e) { log("✗ " + action + " — rejected: " + e.message, "err"); }
  function info(msg) { log(msg, "info"); }

  // ------------------------------------------------------------ checklist
  function checklistState() {
    if (!started) return 0;
    if (!sim.created) return 0;
    if (sim.phase === "Registration") return 1;
    if (sim.phase === "Active") {
      if (sim.currentWinner !== null) return 4;
      if (sim.allContributed()) return 3;
      return 2;
    }
    if (sim.phase === "Completed") return 5;
    return 6; // Closed
  }

  function renderChecklist() {
    var roundLabel = sim.created && sim.phase === "Active"
      ? " (round " + sim.round + " of " + sim.totalRounds() + ")" : "";
    var steps = [
      "Create the circle — create_circle: 10 members, 200 TARI per round",
      "Ibu Sari seals the draw — seal_draw: one SHA-256 commitment per round",
      "Every member contributes 200 TARI" + roundLabel,
      "Ibu Sari reveals this round's winner — reveal_winner (checked against the sealed commitment)",
      "The winner claims the whole pot — payout",
      "Repeat until everyone has been paid exactly once, then close_circle"
    ];
    var state = checklistState();
    var el = $("checklist");
    el.innerHTML = "";
    steps.forEach(function (text, i) {
      var li = document.createElement("li");
      li.textContent = text;
      var stepIndex = i < 2 ? i : (i === 5 ? 5 : i); // steps 2..4 repeat per round
      if (sim.phase === "Closed" || state > stepIndex) li.className = "done";
      else if (state === stepIndex) li.className = "now";
      el.appendChild(li);
    });
  }

  // -------------------------------------------------------------- rendering
  function renderStatus() {
    $("st-phase").textContent = !started ? "Not created yet" : sim.phase;
    $("st-round").textContent = !started ? "—"
      : (sim.phase === "Registration" ? "0 (registration)"
        : sim.round + " of " + sim.totalRounds());
    $("st-pot").textContent = !started ? "—" : fmt(sim.potBalance()) + " TARI";
  }

  function renderMembers() {
    var wrap = $("members");
    wrap.innerHTML = "";
    if (!started) {
      wrap.innerHTML = "<p>The circle has not been created yet — the ten members will appear here.</p>";
      return;
    }
    sim.members.forEach(function (m, i) {
      var div = document.createElement("div");
      div.className = "member" + (sim.currentWinner === i ? " is-winner" : "");
      var badges = "";
      if (i === sim.admin) badges += '<span class="badge admin">admin · treasurer</span>';
      if (sim.phase === "Active" && sim.hasContributed(i)) badges += '<span class="badge in">contributed ✓</span>';
      if (sim.paid.indexOf(i) !== -1) badges += '<span class="badge paid">paid ✓</span>';
      if (sim.currentWinner === i) badges += '<span class="badge winner">this round\'s winner</span>';
      div.innerHTML =
        '<div class="name">' + m.name + "</div>" +
        '<div class="key">key ' + shortKey(m.keyHex) + "</div>" +
        '<div class="bal">Wallet: <strong>' + fmt(sim.balances[i]) + " TARI</strong></div>" +
        "<div>" + badges + "</div>";
      wrap.appendChild(div);
    });
  }

  function renderCommitments() {
    var card = $("commitments-card");
    if (!started || sim.commitments.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    var el = $("commitments");
    el.innerHTML = "";
    sim.commitments.forEach(function (c, i) {
      var li = document.createElement("li");
      var revealed = sim.revealed.some(function (r) { return r.round === i + 1; });
      li.textContent = "Round " + (i + 1) + ": " + c + (revealed ? "  ← revealed (see log)" : "");
      if (revealed) li.className = "revealed";
      el.appendChild(li);
    });
  }

  function renderReveal() {
    var box = $("reveal-box");
    if (!lastReveal || sim.currentWinner === null) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      "<strong>Round " + lastReveal.round + " winner revealed: " + sim.members[lastReveal.winner].name + "</strong><br>" +
      'salt: <span class="mono">' + lastReveal.saltHex + "</span><br>" +
      'sha256(winner_key || salt) = <span class="mono">' + lastReveal.digest + "</span><br>" +
      'sealed commitment, round ' + lastReveal.round + ': <span class="mono">' + lastReveal.commitment + "</span><br>" +
      '<span class="verified">✓ Match — the order was fixed at seal time and could not be changed.</span>';
  }

  function renderActions() {
    var el = $("actions");
    el.innerHTML = "";
    function btn(label, cls, handler) {
      var b = document.createElement("button");
      b.className = "btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", handler);
      el.appendChild(b);
      return b;
    }

    if (!started) {
      btn("1 · Create the circle (create_circle)", "", function () {
        try {
          sim.createCircle(NAMES, CONTRIBUTION, START_BALANCE);
          started = true;
          ok("create_circle — circle created by Ibu Sari (admin). 10 members, contribution 200 TARI, " +
             sim.totalRounds() + " rounds. Phase: Registration.");
        } catch (e) { err("create_circle", e); }
        render();
      });
      return;
    }

    if (sim.phase === "Registration") {
      btn("2 · Seal the draw (seal_draw)", "", function () {
        try {
          sim.sealDraw(sim.admin);
          ok("seal_draw — Ibu Sari sealed one SHA-256 commitment per round. " +
             "The rotation order itself is NOT shown anywhere — only the hashes below. Phase: Active, round 1.");
        } catch (e) { err("seal_draw", e); }
        render();
      });
      return;
    }

    if (sim.phase === "Active" && sim.currentWinner === null && !sim.allContributed()) {
      sim.members.forEach(function (m, i) {
        if (sim.hasContributed(i)) return;
        var b = btn(m.name + " contributes 200 TARI", "ghost small", function () {
          try {
            sim.contribute(i);
            ok("contribute — " + m.name + " put 200 TARI into the vault. Pot: " + fmt(sim.potBalance()) + " TARI.");
          } catch (e) { err("contribute (" + m.name + ")", e); }
          render();
        });
        b.title = "contribute";
      });
      btn("Everyone contributes", "", function () {
        sim.members.forEach(function (m, i) {
          if (sim.hasContributed(i)) return;
          try {
            sim.contribute(i);
            ok("contribute — " + m.name + " put 200 TARI into the vault.");
          } catch (e) { err("contribute (" + m.name + ")", e); }
        });
        info("Pot is now " + fmt(sim.potBalance()) + " TARI. The winner can now be revealed.");
        render();
      });
      return;
    }

    if (sim.phase === "Active" && sim.currentWinner === null && sim.allContributed()) {
      btn("4 · Reveal this round's winner (reveal_winner)", "", function () {
        var secret = sim.adminSecretForCurrentRound();
        try {
          sim.revealWinner(sim.admin, secret.winner, secret.saltHex);
          lastReveal = {
            round: sim.round,
            winner: secret.winner,
            saltHex: secret.saltHex,
            digest: sim.verifyReveal(secret.winner, secret.saltHex),
            commitment: sim.commitmentForRound(sim.round)
          };
          ok("reveal_winner — round " + sim.round + " winner is " + sim.members[secret.winner].name +
             ". The reveal matched the sealed commitment for this round.");
        } catch (e) { err("reveal_winner", e); }
        render();
      });
      return;
    }

    if (sim.phase === "Active" && sim.currentWinner !== null) {
      var winnerName = sim.members[sim.currentWinner].name;
      btn("5 · " + winnerName + " claims the pot (payout)", "", function () {
        try {
          var amount = sim.payout(sim.currentWinner);
          ok("payout — " + winnerName + " claimed " + fmt(amount) + " TARI. " +
             (sim.phase === "Completed"
               ? "Everyone has now been paid exactly once. Phase: Completed."
               : "Next: round " + sim.round + " of " + sim.totalRounds() + "."));
          lastReveal = null;
        } catch (e) { err("payout", e); }
        render();
      });
      return;
    }

    if (sim.phase === "Completed") {
      btn("6 · Close the circle (close_circle)", "", function () {
        try {
          sim.closeCircle(sim.admin);
          ok("close_circle — circle closed by Ibu Sari. Final check: every member contributed " +
             "10 × 200 TARI and received 2.000 TARI exactly once, so every wallet is back to " +
             fmt(START_BALANCE) + " TARI. A fair arisan.");
        } catch (e) { err("close_circle", e); }
        render();
      });
      return;
    }

    if (sim.phase === "Closed") {
      btn("Restart the simulation", "ghost", function () { location.reload(); });
    }
  }

  function render() {
    renderChecklist();
    renderStatus();
    renderMembers();
    renderCommitments();
    renderReveal();
    renderActions();
  }

  // --------------------------------------------------------- break-it panel
  function needStarted() {
    if (!started) { info("Create the circle first — the buttons below act on the live simulation."); return false; }
    return true;
  }

  var breakHandlers = {
    double: function () {
      if (!needStarted()) return;
      if (sim.phase !== "Active") { info("Not applicable now — the circle is not in an active round."); return; }
      var idx = sim.members.findIndex(function (_, i) { return !sim.hasContributed(i); });
      if (idx === -1) { info("Not applicable now — everyone has already contributed this round."); return; }
      try { sim.contribute(idx); ok("contribute — " + sim.members[idx].name + " contributed (first time, valid). Trying again…"); }
      catch (e) { err("contribute", e); render(); return; }
      try { sim.contribute(idx); } catch (e) { err("contribute again (" + sim.members[idx].name + ")", e); }
      render();
    },
    amount: function () {
      if (!needStarted()) return;
      var idx = sim.members.findIndex(function (_, i) { return !sim.hasContributed(i); });
      if (sim.phase !== "Active" || idx === -1) { info("Not applicable now — no pending contribution to tamper with."); return; }
      try { sim.contribute(idx, 150); } catch (e) { err("contribute 150 TARI (" + sim.members[idx].name + ")", e); }
      render();
    },
    outsider: function () {
      if (!needStarted()) return;
      try { sim.contribute("Ibu Orang Luar"); } catch (e) { err("contribute (non-member 'Ibu Orang Luar')", e); }
      render();
    },
    early: function () {
      if (!needStarted()) return;
      if (sim.phase !== "Active") { info("Not applicable now — the circle is not in an active round."); return; }
      if (sim.allContributed()) { info("Not applicable now — everyone has contributed, so revealing is allowed. Use the reveal button."); return; }
      var secret = sim.adminSecretForCurrentRound();
      try { sim.revealWinner(sim.admin, secret.winner, secret.saltHex); }
      catch (e) { err("reveal_winner (too early)", e); }
      render();
    },
    tamper: function () {
      if (!needStarted()) return;
      if (sim.phase !== "Active" || !sim.allContributed() || sim.currentWinner !== null) {
        info("Not applicable now — tampering is attempted at reveal time, once everyone has contributed.");
        return;
      }
      var secret = sim.adminSecretForCurrentRound();
      var other = (secret.winner + 1) % sim.members.length;
      if (sim.paid.indexOf(other) !== -1) other = (other + 1) % sim.members.length;
      try { sim.revealWinner(sim.admin, other, secret.saltHex); }
      catch (e) { err("reveal_winner (tampered: " + sim.members[other].name + " with the real salt)", e); }
      render();
    },
    claim: function () {
      if (!needStarted()) return;
      if (sim.phase !== "Active") { info("Not applicable now — the circle is not in an active round."); return; }
      var actor = sim.currentWinner === null ? 0 : (sim.currentWinner + 1) % sim.members.length;
      try { sim.payout(actor); }
      catch (e) { err("payout (by " + sim.members[actor].name + ", not the winner)", e); }
      render();
    }
  };

  document.querySelectorAll("[data-break]").forEach(function (b) {
    b.addEventListener("click", function () { breakHandlers[b.getAttribute("data-break")](); });
  });

  info("Welcome. This is a simulation of the ArisanCircle template — start with step 1.");
  render();
})();
