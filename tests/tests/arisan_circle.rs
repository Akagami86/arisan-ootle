// Engine tests for the Arisan Rahasia (private ROSCA) template.
// SPDX-License-Identifier: MIT
//
// Run with: cargo test (from the `tests/` crate directory).
// The template under `../template` is compiled to WASM and executed in-process
// by tari_template_test_tooling — no network or node is required.

use sha2::{Digest, Sha256};
use tari_crypto::{
    keys::PublicKey,
    ristretto::{RistrettoPublicKey, RistrettoSecretKey},
};
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    Amount,
    ComponentAddress,
    NonFungibleAddress,
    constants::TARI_TOKEN,
    crypto::RistrettoPublicKeyBytes,
};
use tari_template_test_tooling::{TemplateTest, byte_type::ToByteType};

/// Per-round contribution used across the tests (in TARI).
const CONTRIBUTION: u64 = 200;
const TEMPLATE_NAME: &str = "ArisanCircle";

fn new_test() -> TemplateTest {
    TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../template"])
}

struct Admin {
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    pk: RistrettoPublicKeyBytes,
}

struct Member {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    pk: RistrettoPublicKeyBytes,
}

fn create_admin(test: &mut TemplateTest) -> Admin {
    let (proof, public_key, key) = test.create_owner_proof();
    Admin {
        proof,
        key,
        pk: public_key.to_byte_type(),
    }
}

fn create_member(test: &mut TemplateTest) -> Member {
    let (account, proof, key) = test.create_funded_account();
    Member {
        account,
        proof,
        pk: RistrettoPublicKey::from_secret_key(&key).to_byte_type(),
        key,
    }
}

fn create_members(test: &mut TemplateTest, n: usize) -> Vec<Member> {
    (0..n).map(|_| create_member(test)).collect()
}

/// The sealed commitment for a round: sha256(winner_public_key_bytes || salt).
fn commitment(winner: &RistrettoPublicKeyBytes, salt: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(winner.as_bytes());
    hasher.update(salt);
    hasher.finalize().to_vec()
}

fn salt_for(round: u32) -> Vec<u8> {
    format!("arisan-rahasia-salt-round-{round}").into_bytes()
}

/// Creates a circle signed by `admin` and returns the component address.
fn create_circle(
    test: &mut TemplateTest,
    admin: &Admin,
    members: &[Member],
    contribution: u64,
) -> ComponentAddress {
    let template = test.get_template_address(TEMPLATE_NAME);
    let member_pks: Vec<RistrettoPublicKeyBytes> = members.iter().map(|m| m.pk).collect();
    test.execute_expect_success(
        test.transaction()
            .call_function(template, "create_circle", args![member_pks, contribution])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
    test.return_values()[0].decoded::<ComponentAddress>().unwrap()
}

/// Attempts to create a circle, expecting the transaction to be rejected.
fn create_circle_expect_failure(
    test: &mut TemplateTest,
    admin: &Admin,
    member_pks: Vec<RistrettoPublicKeyBytes>,
    contribution: u64,
) {
    let template = test.get_template_address(TEMPLATE_NAME);
    test.execute_expect_failure(
        test.transaction()
            .call_function(template, "create_circle", args![member_pks, contribution])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

/// Seals the draw for the given payout order (member indices per round).
/// Returns the salts used, one per round.
fn seal_draw(test: &mut TemplateTest, admin: &Admin, circle: ComponentAddress, members: &[Member], order: &[usize]) -> Vec<Vec<u8>> {
    let salts: Vec<Vec<u8>> = (1..=order.len() as u32).map(salt_for).collect();
    let commitments: Vec<Vec<u8>> = order
        .iter()
        .enumerate()
        .map(|(i, &member_idx)| commitment(&members[member_idx].pk, &salts[i]))
        .collect();
    test.execute_expect_success(
        test.transaction()
            .call_method(circle, "seal_draw", args![commitments])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
    salts
}

fn contribute(test: &mut TemplateTest, circle: ComponentAddress, member: &Member, amount: u64) {
    test.execute_expect_success(
        test.transaction()
            .call_method(member.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("contribution")
            .call_method(circle, "contribute", args![Workspace("contribution")])
            .build_and_seal(&member.key),
        vec![member.proof.clone()],
    );
}

fn contribute_expect_failure(test: &mut TemplateTest, circle: ComponentAddress, member: &Member, amount: u64) {
    test.execute_expect_failure(
        test.transaction()
            .call_method(member.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("contribution")
            .call_method(circle, "contribute", args![Workspace("contribution")])
            .build_and_seal(&member.key),
        vec![member.proof.clone()],
    );
}

fn contribute_all(test: &mut TemplateTest, circle: ComponentAddress, members: &[Member]) {
    for member in members {
        contribute(test, circle, member, CONTRIBUTION);
    }
}

fn reveal(test: &mut TemplateTest, admin: &Admin, circle: ComponentAddress, winner: &Member, salt: &[u8]) {
    test.execute_expect_success(
        test.transaction()
            .call_method(circle, "reveal_winner", args![winner.pk, salt.to_vec()])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

/// The winner claims the pot and deposits it into their own account.
fn payout(test: &mut TemplateTest, circle: ComponentAddress, winner: &Member) {
    test.execute_expect_success(
        test.transaction()
            .call_method(circle, "payout", args![])
            .put_last_instruction_output_on_workspace("pot")
            .call_method(winner.account, "deposit", args![Workspace("pot")])
            .build_and_seal(&winner.key),
        vec![winner.proof.clone()],
    );
}

fn balance(test: &mut TemplateTest, account: ComponentAddress) -> Amount {
    test.call_method(account, "balance", args![TARI_TOKEN], vec![])
}

fn phase(test: &mut TemplateTest, circle: ComponentAddress) -> String {
    test.call_method(circle, "phase", args![], vec![])
}

fn view_round(test: &mut TemplateTest, circle: ComponentAddress) -> u32 {
    test.call_method(circle, "round", args![], vec![])
}

// ---------------------------------------------------------------------------
// Creation validation
// ---------------------------------------------------------------------------

#[test]
fn create_circle_sets_up_registration_state() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);

    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);

    assert_eq!(phase(&mut test, circle), "Registration");
    assert_eq!(view_round(&mut test, circle), 0);
    let total_rounds: u32 = test.call_method(circle, "total_rounds", args![], vec![]);
    assert_eq!(total_rounds, 3);
    let stored_members: Vec<RistrettoPublicKeyBytes> = test.call_method(circle, "members", args![], vec![]);
    assert_eq!(stored_members.len(), 3);
    let contribution: Amount = test.call_method(circle, "contribution_amount", args![], vec![]);
    assert_eq!(contribution, Amount::from(CONTRIBUTION));
    let stored_admin: RistrettoPublicKeyBytes = test.call_method(circle, "admin", args![], vec![]);
    assert_eq!(stored_admin, admin.pk);
}

#[test]
fn create_circle_with_too_few_members_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 1);
    create_circle_expect_failure(&mut test, &admin, vec![members[0].pk], CONTRIBUTION);
}

#[test]
fn create_circle_with_duplicate_members_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 2);
    create_circle_expect_failure(&mut test, &admin, vec![members[0].pk, members[0].pk], CONTRIBUTION);
}

#[test]
fn create_circle_with_zero_contribution_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 2);
    let pks: Vec<RistrettoPublicKeyBytes> = members.iter().map(|m| m.pk).collect();
    create_circle_expect_failure(&mut test, &admin, pks, 0);
}

// ---------------------------------------------------------------------------
// Sealing the draw
// ---------------------------------------------------------------------------

#[test]
fn seal_draw_activates_circle() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);

    seal_draw(&mut test, &admin, circle, &members, &[2, 0, 1]);

    assert_eq!(phase(&mut test, circle), "Active");
    assert_eq!(view_round(&mut test, circle), 1);
}

#[test]
fn seal_draw_by_non_admin_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);

    let commitments: Vec<Vec<u8>> = (0..3).map(|_| vec![7u8; 32]).collect();
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "seal_draw", args![commitments])
            .build_and_seal(&members[0].key),
        vec![members[0].proof.clone()],
    );
    assert_eq!(phase(&mut test, circle), "Registration");
}

#[test]
fn seal_draw_with_wrong_commitment_count_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);

    // 2 commitments for a 3-round circle
    let commitments: Vec<Vec<u8>> = (0..2).map(|_| vec![7u8; 32]).collect();
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "seal_draw", args![commitments])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

#[test]
fn seal_draw_twice_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);

    let commitments: Vec<Vec<u8>> = (0..3).map(|_| vec![9u8; 32]).collect();
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "seal_draw", args![commitments])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

#[test]
fn contribute_before_seal_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);

    contribute_expect_failure(&mut test, circle, &members[0], CONTRIBUTION);
}

#[test]
fn contribute_wrong_amount_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);

    contribute_expect_failure(&mut test, circle, &members[0], CONTRIBUTION - 1);
    contribute_expect_failure(&mut test, circle, &members[0], CONTRIBUTION + 1);

    // The correct amount still works afterwards.
    contribute(&mut test, circle, &members[0], CONTRIBUTION);
    let has: bool = test.call_method(circle, "has_contributed", args![members[0].pk], vec![]);
    assert!(has);
}

#[test]
fn contribute_by_non_member_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);

    let outsider = create_member(&mut test);
    contribute_expect_failure(&mut test, circle, &outsider, CONTRIBUTION);
}

#[test]
fn contribute_twice_in_one_round_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);

    contribute(&mut test, circle, &members[0], CONTRIBUTION);
    contribute_expect_failure(&mut test, circle, &members[0], CONTRIBUTION);
}

// ---------------------------------------------------------------------------
// Reveal and payout
// ---------------------------------------------------------------------------

#[test]
fn reveal_before_all_contributed_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let salts = seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);

    contribute(&mut test, circle, &members[0], CONTRIBUTION);
    contribute(&mut test, circle, &members[1], CONTRIBUTION);
    // members[2] has not contributed yet.

    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "reveal_winner", args![members[0].pk, salts[0].clone()])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

#[test]
fn reveal_with_wrong_salt_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);
    contribute_all(&mut test, circle, &members);

    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "reveal_winner", args![members[0].pk, b"not-the-salt".to_vec()])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

#[test]
fn reveal_with_wrong_winner_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let salts = seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);
    contribute_all(&mut test, circle, &members);

    // The round-1 salt belongs to members[0]; revealing members[1] with it must fail.
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "reveal_winner", args![members[1].pk, salts[0].clone()])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}

#[test]
fn payout_before_reveal_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);
    contribute_all(&mut test, circle, &members);

    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "payout", args![])
            .build_and_seal(&members[0].key),
        vec![members[0].proof.clone()],
    );
}

#[test]
fn payout_by_non_winner_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let salts = seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);
    contribute_all(&mut test, circle, &members);
    reveal(&mut test, &admin, circle, &members[0], &salts[0]);

    // members[1] is not the revealed winner.
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "payout", args![])
            .build_and_seal(&members[1].key),
        vec![members[1].proof.clone()],
    );
}

#[test]
fn full_round_pays_pot_to_revealed_winner() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    // Rotation: member 2 first, then member 0, then member 1.
    let salts = seal_draw(&mut test, &admin, circle, &members, &[2, 0, 1]);

    let initial = balance(&mut test, members[2].account);
    contribute_all(&mut test, circle, &members);

    let pot: Amount = test.call_method(circle, "pot_balance", args![], vec![]);
    assert_eq!(pot, Amount::from(CONTRIBUTION * 3));

    // The winner stays hidden until the admin reveals them.
    let hidden: Option<RistrettoPublicKeyBytes> = test.call_method(circle, "current_winner", args![], vec![]);
    assert_eq!(hidden, None);

    reveal(&mut test, &admin, circle, &members[2], &salts[0]);
    let shown: Option<RistrettoPublicKeyBytes> = test.call_method(circle, "current_winner", args![], vec![]);
    assert_eq!(shown, Some(members[2].pk));

    payout(&mut test, circle, &members[2]);

    // Winner paid their own 200 in and received the full 600 pot: net +400.
    assert_eq!(balance(&mut test, members[2].account), initial + Amount::from(400u64));
    // The circle advanced to round 2 with an empty pot.
    assert_eq!(view_round(&mut test, circle), 2);
    let pot_after: Amount = test.call_method(circle, "pot_balance", args![], vec![]);
    assert_eq!(pot_after, Amount::from(0u64));
    let paid: Vec<RistrettoPublicKeyBytes> = test.call_method(circle, "paid", args![], vec![]);
    assert_eq!(paid, vec![members[2].pk]);
}

#[test]
fn double_payout_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let salts = seal_draw(&mut test, &admin, circle, &members, &[0, 1, 2]);
    contribute_all(&mut test, circle, &members);
    reveal(&mut test, &admin, circle, &members[0], &salts[0]);
    payout(&mut test, circle, &members[0]);

    // Round 2 has no revealed winner yet, so a second claim must fail.
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "payout", args![])
            .build_and_seal(&members[0].key),
        vec![members[0].proof.clone()],
    );
}

#[test]
fn reveal_of_already_paid_member_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 2);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let salts = seal_draw(&mut test, &admin, circle, &members, &[0, 1]);
    contribute_all(&mut test, circle, &members);
    reveal(&mut test, &admin, circle, &members[0], &salts[0]);
    payout(&mut test, circle, &members[0]);

    // Round 2: everyone contributes again, then the admin tries to reveal the
    // already-paid member 0 with a fresh salt — the template must refuse because
    // member 0 already received their payout (checked before the commitment).
    contribute_all(&mut test, circle, &members);
    let fake_salt = b"fake-salt".to_vec();
    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "reveal_winner", args![members[0].pk, fake_salt])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );

    // The honest reveal of member 1 still works.
    reveal(&mut test, &admin, circle, &members[1], &salts[1]);
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

#[test]
fn full_circle_completes_and_closes() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 3);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    let order = [1usize, 2, 0];
    let salts = seal_draw(&mut test, &admin, circle, &members, &order);

    let initials: Vec<Amount> = members.iter().map(|m| balance(&mut test, m.account)).collect();

    for (round_idx, &winner_idx) in order.iter().enumerate() {
        contribute_all(&mut test, circle, &members);
        reveal(&mut test, &admin, circle, &members[winner_idx], &salts[round_idx]);
        payout(&mut test, circle, &members[winner_idx]);
    }

    assert_eq!(phase(&mut test, circle), "Completed");
    let paid: Vec<RistrettoPublicKeyBytes> = test.call_method(circle, "paid", args![], vec![]);
    assert_eq!(paid.len(), 3);

    // In a fair ROSCA everyone ends where they started: 3 contributions of 200
    // out, one pot of 600 in.
    for (i, member) in members.iter().enumerate() {
        assert_eq!(balance(&mut test, member.account), initials[i]);
    }

    // Close the circle.
    test.execute_expect_success(
        test.transaction()
            .call_method(circle, "close_circle", args![])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
    assert_eq!(phase(&mut test, circle), "Closed");
}

#[test]
fn close_before_completion_fails() {
    let mut test = new_test();
    let admin = create_admin(&mut test);
    let members = create_members(&mut test, 2);
    let circle = create_circle(&mut test, &admin, &members, CONTRIBUTION);
    seal_draw(&mut test, &admin, circle, &members, &[0, 1]);

    test.execute_expect_failure(
        test.transaction()
            .call_method(circle, "close_circle", args![])
            .build_and_seal(&admin.key),
        vec![admin.proof.clone()],
    );
}
