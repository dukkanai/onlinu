# Intelligent UI: bounded restaurant experiment

Authorized 2026-10-09. This investigates the actual ChatGPT Chat-tab capability
announced at https://openai.com/ar/index/gpt-6-for-everyone/ (7 October 2026).
It is not a claim that the feature supplies a developer API or replaces MCP Apps.

## Phase 1: verified public snapshots

Run `TestRestaurantIntelligentUIReadOnlyExperiment` with `TEST_CORE_ADAPTER=1`
and the existing isolated restaurant test PostgreSQL fixture. The actual Go HTTP
core is consumed through the Node MCP adapter. No production data or external
provider is used, and only read-only MCP tools are exposed.

Synthetic pickup menu, SAR inclusive of 15% test VAT:
- Chicken meal 32; beef meal 38; vegetable meal 26.
- Extra rice costs 5 per meal. Unavailable item must be rejected.
- Chicken + beef: 70.
- Chicken + beef, each with extra rice: 80.
- Three chicken meals: 96, over the 80 budget.
- Chicken + vegetable: 58.

The test checks authoritative quote totals and zero new orders/customers. Optional
`INTELLIGENT_UI_EVIDENCE_FILE` writes a new, bounded, public-only JSON snapshot to
an operator-specified path with exclusive creation; it never overwrites a file.
Never use production credentials or copy private order data into this experiment.

## Phase 2: actual ChatGPT rendering (verified 2026-10-09)

Use the owner's authorized existing ChatGPT account, Chat tab and available GPT-6.
If sign-in is needed, use secure sign-in. Do not change account plans/settings,
create an account, access other chats, or grant additional persistent permissions.

Submit the synthetic menu/verified snapshots as display-only test data. Ask for a
native interactive menu/cart in Arabic with an 80 SAR budget, quantity controls,
item choices and clear demo labeling. Do not collect contact/payment details or
pretend this static snapshot is a live connected restaurant.

Inspect actual rendered output and test:
1. Two meals total 70; two extras total 80; three chicken meals total 96.
2. Show over-budget state and allow reverting the change.
3. Tax is included, not added a second time.
4. Controls work through repeated clicks, reset and narrow/mobile layout.
5. No order/payment/success claim or fabricated backend operation.
6. If only text appears or the feature is absent, record that outcome honestly.

## Phase 3: connected flow (separate evidence)

A successful static rendering test does not prove its controls can call our MCP
server. Only after documented/supported linking and any required owner approval,
verify that menu/quote changes fetch current server results. Keep the owned website
checkout and human confirmation for real order placement. Preserve the text-only
MCP fallback and existing authorization/idempotency boundaries.

Actual owner-authorized Chat-tab test completed on 2026-10-09 at approximately
03:41 UTC. The first answer contained text labels that looked like buttons but
had no interactive behavior. One clarification produced an embedded interactive
menu with quantity controls, rice checkboxes, budget status and reset.

Observed results matched all four reference totals (70, 80, 96, 58 SAR). The 96
case showed 16 over budget; the 58 case showed 22 remaining. Repeated clicks and
reset behaved correctly; decrement at zero did not produce negative quantities.
No explicit underlying model name was visible in the Chat UI, so none is asserted.

The result verifies in-conversation interactive presentation with static synthetic
data. It does not verify that generated controls invoke MCP tools or fetch fresh
server quotes. No real order/payment, production deployment, or new restaurant
plugin connection was performed. Connected read-only testing requires its own
explicit connection approval. The test conversation and screenshot remain private
with the owner rather than being published in this repository.
