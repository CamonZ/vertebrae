import { describe, expect, it } from "vitest";
import * as componentExports from "./index";
import * as storeExports from "../stores";

describe("notification migration exports", () => {
  it("does not expose the retired toast component or store", () => {
    expect("ToastContainer" in componentExports).toBe(false);
    expect("useToastStore" in storeExports).toBe(false);
  });
});
