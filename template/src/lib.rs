// Arisan Rahasia — a private rotating savings circle (ROSCA / arisan) on Tari Ootle.
// SPDX-License-Identifier: MIT
//
// Members contribute a fixed amount of TARI every round into a shared vault.
// The payout rotation is committed up-front by the admin as one SHA-256
// commitment per round — sha256(winner_public_key_bytes || salt) — so the order
// cannot be changed once the circle starts, yet only the current round's winner
// is ever revealed. Everyone is paid exactly once; then the circle can be closed.

use tari_template_lib::prelude::*;

#[template]
mod arisan_circle_template {
    use super::*;

    /// A private arisan (ROSCA) circle.
    ///
    /// NOTE: this struct must stay the first type defined in the module — the
    /// `#[template]` macro names the template after the first struct/enum it sees.
    pub struct ArisanCircle {
        /// The circle organiser (e.g. the arisan treasurer) who seals and reveals the draw.
        admin: RistrettoPublicKeyBytes,
        /// Member identities, by account owner public key.
        members: Vec<RistrettoPublicKeyBytes>,
        /// Fixed per-round contribution, in TARI.
        contribution: Amount,
        /// Holds all contributions until each round's payout.
        vault: Vault,
        phase: CirclePhase,
        /// Current round, 1-based once active. 0 during registration.
        round: u32,
        /// One sealed commitment per round: sha256(winner_public_key_bytes || salt).
        commitments: Vec<Vec<u8>>,
        /// Who has already contributed in the current round (aligned with `members`).
        contributed: Vec<bool>,
        /// The revealed winner of the current round, if revealed yet.
        current_winner: Option<RistrettoPublicKeyBytes>,
        /// Members who have already received their payout.
        paid: Vec<RistrettoPublicKeyBytes>,
    }

    /// Lifecycle of a circle.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub enum CirclePhase {
        /// Created, waiting for the admin to seal the payout draw.
        #[default]
        Registration,
        /// Draw sealed; rounds are running.
        Active,
        /// Every member has been paid exactly once.
        Completed,
        /// Closed by the admin after completion.
        Closed,
    }

    impl ArisanCircle {
        /// Creates a new circle. The transaction signer becomes the admin.
        /// The number of rounds equals the number of members: everyone is paid exactly once.
        pub fn create_circle(members: Vec<RistrettoPublicKeyBytes>, contribution: Amount) -> Component<Self> {
            assert!(members.len() >= 2, "An arisan circle needs at least 2 members");
            assert!(
                contribution > Amount::from(0u64),
                "The per-round contribution must be greater than zero"
            );
            for (i, member) in members.iter().enumerate() {
                assert!(!members[..i].contains(member), "Duplicate member in the member list");
            }

            let admin = CallerContext::transaction_signer_public_key();

            Component::new(Self {
                admin,
                members,
                contribution,
                vault: Vault::new_empty(TARI_TOKEN),
                phase: CirclePhase::Registration,
                round: 0,
                commitments: Vec::new(),
                contributed: Vec::new(),
                current_winner: None,
                paid: Vec::new(),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// Seals the payout rotation. Admin only, once, before the first round.
        ///
        /// `commitments` holds one 32-byte SHA-256 hash per round:
        /// sha256(winner_public_key_bytes || salt). The admin keeps the salts secret
        /// and reveals exactly one winner per round via [`ArisanCircle::reveal_winner`].
        pub fn seal_draw(&mut self, commitments: Vec<Vec<u8>>) {
            assert!(
                self.phase == CirclePhase::Registration,
                "The draw can only be sealed once, before the circle starts"
            );
            let caller = CallerContext::transaction_signer_public_key();
            assert!(caller == self.admin, "Only the circle admin can seal the draw");
            assert!(
                commitments.len() == self.members.len(),
                "Exactly one commitment per round is required"
            );
            for commitment in &commitments {
                assert!(commitment.len() == 32, "Each commitment must be a 32-byte SHA-256 hash");
            }

            self.commitments = commitments;
            self.contributed = vec![false; self.members.len()];
            self.round = 1;
            self.phase = CirclePhase::Active;
        }

        /// Contributes this round's fixed amount. Members only, exactly once per round,
        /// and the bucket must hold exactly the agreed contribution in TARI.
        pub fn contribute(&mut self, bucket: Bucket) {
            assert!(self.phase == CirclePhase::Active, "The circle is not active");
            assert!(bucket.resource_address() == TARI_TOKEN, "Contributions must be made in TARI");
            let caller = CallerContext::transaction_signer_public_key();
            let index = self
                .members
                .iter()
                .position(|member| *member == caller)
                .expect("Only circle members can contribute");
            assert!(
                !self.contributed[index],
                "This member has already contributed in the current round"
            );
            assert!(
                bucket.amount() == self.contribution,
                "The contribution must be exactly the agreed round amount"
            );

            self.vault.deposit(bucket);
            self.contributed[index] = true;
        }

        /// Reveals the current round's winner. Admin only, and only after every member
        /// has contributed. The reveal is verified against the sealed commitment, so the
        /// admin cannot change the order after seeing the contributions.
        pub fn reveal_winner(&mut self, winner: RistrettoPublicKeyBytes, salt: Vec<u8>) {
            assert!(self.phase == CirclePhase::Active, "The circle is not active");
            let caller = CallerContext::transaction_signer_public_key();
            assert!(caller == self.admin, "Only the circle admin can reveal the winner");
            assert!(
                self.current_winner.is_none(),
                "The winner of the current round has already been revealed"
            );
            assert!(
                self.contributed.iter().all(|c| *c),
                "All members must contribute before the winner is revealed"
            );
            assert!(self.members.contains(&winner), "The revealed winner is not a circle member");
            assert!(
                !self.paid.contains(&winner),
                "The revealed winner has already received a payout"
            );

            let digest = intrinsics::hash_sha256_parts(&[winner.as_bytes(), &salt]);
            let expected = &self.commitments[(self.round - 1) as usize];
            assert!(
                digest.as_slice() == expected.as_slice(),
                "The reveal does not match the sealed commitment for this round"
            );

            self.current_winner = Some(winner);
        }

        /// Pays out the whole pot to the revealed winner of the current round.
        /// Only the winner can claim; the returned bucket is theirs to deposit.
        /// Advances the circle to the next round, or completes it when every
        /// member has been paid.
        pub fn payout(&mut self) -> Bucket {
            assert!(self.phase == CirclePhase::Active, "The circle is not active");
            let winner = self
                .current_winner
                .expect("The winner of the current round has not been revealed yet");
            let caller = CallerContext::transaction_signer_public_key();
            assert!(caller == winner, "Only the revealed winner can claim the payout");

            let bucket = self.vault.withdraw(self.vault.balance());

            self.paid.push(winner);
            self.current_winner = None;
            if self.paid.len() == self.members.len() {
                self.phase = CirclePhase::Completed;
            } else {
                self.round += 1;
                self.contributed = vec![false; self.members.len()];
            }

            bucket
        }

        /// Closes the circle. Admin only, once every member has been paid and the
        /// vault is empty.
        pub fn close_circle(&mut self) {
            let caller = CallerContext::transaction_signer_public_key();
            assert!(caller == self.admin, "Only the circle admin can close the circle");
            assert!(
                self.phase == CirclePhase::Completed,
                "The circle can only be closed once every member has been paid"
            );
            assert!(self.vault.balance() == Amount::from(0u64), "The circle vault is not empty");
            self.phase = CirclePhase::Closed;
        }

        // ------------------------------ views ------------------------------

        pub fn admin(&self) -> RistrettoPublicKeyBytes {
            self.admin
        }

        pub fn members(&self) -> Vec<RistrettoPublicKeyBytes> {
            self.members.clone()
        }

        pub fn contribution_amount(&self) -> Amount {
            self.contribution
        }

        /// Current round (1-based while active, 0 during registration).
        pub fn round(&self) -> u32 {
            self.round
        }

        pub fn total_rounds(&self) -> u32 {
            self.members.len() as u32
        }

        /// One of "Registration", "Active", "Completed", "Closed".
        pub fn phase(&self) -> String {
            match self.phase {
                CirclePhase::Registration => "Registration",
                CirclePhase::Active => "Active",
                CirclePhase::Completed => "Completed",
                CirclePhase::Closed => "Closed",
            }
            .to_string()
        }

        pub fn current_winner(&self) -> Option<RistrettoPublicKeyBytes> {
            self.current_winner
        }

        pub fn paid(&self) -> Vec<RistrettoPublicKeyBytes> {
            self.paid.clone()
        }

        pub fn has_contributed(&self, member: RistrettoPublicKeyBytes) -> bool {
            match self.members.iter().position(|m| *m == member) {
                Some(index) => self.contributed.get(index).copied().unwrap_or(false),
                None => false,
            }
        }

        /// Current balance held in the circle vault.
        pub fn pot_balance(&self) -> Amount {
            self.vault.balance()
        }
    }
}
