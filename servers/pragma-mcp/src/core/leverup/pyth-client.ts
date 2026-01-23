import { Hex } from "viem";
import { PYTH_HERMES_URL } from "./constants.js";
import { PythUpdateResponse } from "./types.js";
import { withRetryOrThrow } from "../utils/retry.js";

export async function fetchPythPriceData(
  priceIds: Hex[]
): Promise<PythUpdateResponse> {
  const url = new URL(`${PYTH_HERMES_URL}/v2/updates/price/latest`);
  priceIds.forEach(id => url.searchParams.append("ids[]", id));

  return await withRetryOrThrow(
    async () => {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Pyth API error: ${response.statusText}`);
      }
      return (await response.json()) as PythUpdateResponse;
    },
    { operationName: "fetch-pyth-price" }
  );
}
