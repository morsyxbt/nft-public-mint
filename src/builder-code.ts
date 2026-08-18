import { Attribution } from "ox/erc8021";

export const BASE_BUILDER_CODE = "bc_jhxtiha3" as const;

export const BASE_DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [BASE_BUILDER_CODE],
});

export function appendBaseBuilderCode(
  data: string,
  chainId: number | bigint
): string {
  if (BigInt(chainId) !== 8453n) return data;
  return `${data}${BASE_DATA_SUFFIX.slice(2)}`;
}
