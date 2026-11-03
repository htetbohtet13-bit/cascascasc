# Banker returns across rounds

The provider's integration guide (§5.1) defines a bank movement's `round_id`
as the round in which the bank opened or closed. A banker turn can span several
rounds. `BANK_RETURN` therefore need not repeat the `BANK_DEPOSIT` round ID.

The wallet matches these returns to the unique `debit_transaction_id`, player,
game, currency and reason. It still requires an open accepted debit and valid
provider authentication. Ordinary `BET_SETTLE` and rollback matching remains
round-bound. Zero-value bank returns must close their holds too.

History follows the same matching rule and reports returned bank funds separately
from actual bets and wagering requirements.

## Recovering rejected returns

1. Deploy the corrected callback and history code.
2. Let the provider retry failed `BANK_RETURN` credits with their original
   transaction IDs and unchanged bodies, signed with a fresh timestamp. The
   provider guide (§5.3) says credits are retried and flagged for manual review
   after 24 hours. Ask provider support to replay any returns awaiting review.
3. Check that each original debit is `SETTLED` and its one linked credit is
   `APPLIED`, with the expected amount. Check zero returns as well.

Do not add the amounts manually, refund the bank debit, invent replacement credit
IDs, or replay unsigned CSV data. Normal callback processing preserves balance
locking, minor-unit conversion, ledger history and duplicate protection. If a
return was already accepted, an identical callback returns `DUPLICATE` without
adding funds again. A different credit ID cannot close the same debit twice.

No schema migration or balance rewrite is required for this correction.
