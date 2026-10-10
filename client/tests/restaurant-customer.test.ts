import assert from "node:assert/strict";
import test from "node:test";
import {
  lineKey,
  normalizeCart,
  parseTableCode,
  privateTrackingURL,
  safeMenuImage,
  unitPrice,
} from "../src/restaurant/customer/cart";
import type { Catalog } from "../src/restaurant/types";
import { emptyAddress } from "../src/restaurant/types";
import {
  parsePendingSubmission,
  type PendingSubmission,
} from "../src/restaurant/customer/pending";

const catalog = {
  items: [
    {
      id: "dish",
      available: true,
      priceMinor: 1500,
      options: [
        { id: "extra", available: true, priceMinor: 200 },
        { id: "gone", available: false, priceMinor: 100 },
      ],
    },
  ],
} as Catalog;
test("cart normalizes untrusted storage and merges matching option sets", () => {
  assert.deepEqual(
    normalizeCart(
      [
        {
          itemId: "dish",
          quantity: 2,
          optionIds: ["extra", "extra", "gone", "unknown"],
        },
        { itemId: "dish", quantity: 200, optionIds: ["extra"] },
        { itemId: "missing", quantity: 1, optionIds: [] },
        { itemId: "dish", quantity: -1, optionIds: [] },
      ],
      catalog,
    ),
    [{ itemId: "dish", quantity: 99, optionIds: ["extra"] }],
  );
  assert.deepEqual(normalizeCart("invalid", catalog), []);
  assert.equal(unitPrice(catalog.items[0], ["extra"]), 1700);
  assert.equal(
    lineKey({ itemId: "dish", optionIds: ["b", "a"] }),
    lineKey({ itemId: "dish", optionIds: ["a", "b"] }),
  );
});
test("table links cannot move orders to external sites or arbitrary endpoints", () => {
  assert.equal(
    parseTableCode(
      "https://restaurant.test/?table=abcdefgh",
      "https://restaurant.test",
    ),
    "abcdefgh",
  );
  assert.equal(
    parseTableCode("abcdefgh", "https://restaurant.test"),
    "abcdefgh",
  );
  assert.equal(
    parseTableCode(
      "https://evil.test/?table=abcdefgh",
      "https://restaurant.test",
    ),
    "",
  );
  assert.equal(
    parseTableCode("/admin?table=abcdefgh", "https://restaurant.test"),
    "",
  );
  assert.equal(
    parseTableCode("javascript:alert(1)", "https://restaurant.test"),
    "",
  );
});
test("tracking credential stays in fragment, never query, and menu images are local", () => {
  const url = new URL(
    privateTrackingURL("https://restaurant.test", "R123", "private-token"),
  );
  assert.equal(url.searchParams.get("order"), "R123");
  assert.equal(url.search.includes("private-token"), false);
  assert.equal(url.hash, "#token=private-token");
  assert.equal(
    safeMenuImage("https://images.test/food.png"),
    "https://images.test/food.png",
  );
  assert.equal(safeMenuImage("http://images.test/food.png"), undefined);
  assert.equal(
    safeMenuImage("https://user:secret@images.test/food.png"),
    undefined,
  );
  assert.equal(safeMenuImage("https://images.test/food.svg"), undefined);
  assert.equal(safeMenuImage("https://images.test/food.png#secret"), undefined);
  assert.equal(
    safeMenuImage("/restaurant-media/a.png"),
    "/restaurant-media/a.png",
  );
});

test("pending recovery retains the exact retry identity and owner without persistent storage", () => {
  const now = 1_700_000_000_000;
  const pending: PendingSubmission = {
    key: "59fd4c9d-0f07-4f22-9bca-9be816ec70bc",
    customerId: "customer-a",
    createdAt: now,
    input: {
      mode: "pickup",
      customerName: "Test Guest",
      phone: "+966500000000",
      address: emptyAddress(),
      tableCode: "",
      notes: "",
      items: [{ itemId: "dish", quantity: 2, optionIds: [] }],
      expectedTotalMinor: 3000,
    },
    quote: {
      items: [
        {
          itemId: "dish",
          name: "Dish",
          quantity: 2,
          unitPriceMinor: 1500,
          totalMinor: 3000,
          options: [],
        },
      ],
      subtotalMinor: 3000,
      deliveryFeeMinor: 0,
      totalMinor: 3000,
      currency: "SAR",
      demo: true,
    },
  };
  assert.deepEqual(
    parsePendingSubmission(JSON.stringify(pending), now + 1000),
    pending,
  );
  const boundPending = { ...pending, input: { ...pending.input, expectedQuoteHash: "a".repeat(64) } };
  assert.deepEqual(parsePendingSubmission(JSON.stringify(boundPending), now + 1000), boundPending);
  assert.equal("expectedQuoteHash" in parsePendingSubmission(JSON.stringify(pending), now + 1000)!.input, false,
    "legacy unknown-outcome retries must not acquire a different request body");
  for (const hash of ["", "a".repeat(63), "A".repeat(64), "x".repeat(64), {}, null])
    assert.equal(parsePendingSubmission(JSON.stringify({ ...pending, input: { ...pending.input, expectedQuoteHash: hash } }), now), null);
  const districtPending = { ...pending, input: { ...pending.input, mode: "delivery", address: { ...emptyAddress(), regionId: "sa-r-1", cityId: "sa-c-2", districtId: "local-d-3" } } };
  assert.deepEqual(parsePendingSubmission(JSON.stringify(districtPending), now + 1000), districtPending);
  for (const invalidAddress of [
    { ...districtPending.input.address, districtId: {} },
    { ...districtPending.input.address, cityId: "" },
    { ...districtPending.input.address, regionId: "invalid region" },
    { ...districtPending.input.address, districtId: "d".repeat(81) },
  ]) assert.equal(parsePendingSubmission(JSON.stringify({ ...districtPending, input: { ...districtPending.input, address: invalidAddress } }), now), null);
  // A retry is not a new checkout. Preserve its exact key and country so an
  // existing accepted order can be recovered after a country policy change.
  const legacyForeign = {
    ...pending,
    input: { ...pending.input, mode: "delivery", address: { ...emptyAddress(), country: "AE" } },
  };
  assert.deepEqual(
    parsePendingSubmission(JSON.stringify(legacyForeign), now + 1000),
    legacyForeign,
  );
  assert.equal(
    parsePendingSubmission(JSON.stringify({
      ...pending,
      input: { ...pending.input, address: { ...emptyAddress(), country: "ZZ" } },
    }), now),
    null,
  );
  assert.equal(
    parsePendingSubmission(
      JSON.stringify({ ...pending, key: "not-uuid" }),
      now,
    ),
    null,
  );
  assert.equal(
    parsePendingSubmission(
      JSON.stringify({ ...pending, createdAt: now - 86_400_001 }),
      now,
    ),
    null,
  );
  assert.equal(
    parsePendingSubmission(
      JSON.stringify({
        ...pending,
        quote: { ...pending.quote, totalMinor: 1 },
      }),
      now,
    ),
    null,
  );
  assert.equal(
    parsePendingSubmission(
      JSON.stringify({ ...pending, input: { ...pending.input, address: {} } }),
      now,
    ),
    null,
  );
  assert.equal(parsePendingSubmission("x".repeat(100_001), now), null);
  assert.equal(parsePendingSubmission("{broken json", now), null);
});
