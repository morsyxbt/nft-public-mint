const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendBaseBuilderCode,
  BASE_DATA_SUFFIX,
} = require("../dist/builder-code");

test("appends the ERC-8021 builder code only on Base mainnet", () => {
  const calldata = "0xabcdef";

  assert.equal(
    appendBaseBuilderCode(calldata, 8453),
    `${calldata}${BASE_DATA_SUFFIX.slice(2)}`,
  );
  assert.equal(appendBaseBuilderCode(calldata, 1), calldata);
  assert.equal(appendBaseBuilderCode(calldata, 31337), calldata);
});

test("uses the ERC-8021 marker", () => {
  assert.match(BASE_DATA_SUFFIX, /80218021802180218021802180218021$/);
});
