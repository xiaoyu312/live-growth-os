// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import { classifySpeechTags, ASR_HOTWORDS } from "../src/speech-tags";
// Independently authored synthetic fixture; seed 42001.
describe("generic speech tags", () => {
  it("keeps empty or unknown text unknown", () => {
    expect(classifySpeechTags("")).toEqual(["other"]);
    expect(classifySpeechTags("   ")).toEqual(["other"]);
    expect(classifySpeechTags("今天晴朗")).toEqual(["other"]);
  });
  it("tags a synthetic price and product-card instruction", () => {
    expect(classifySpeechTags("演示价格100元，点开商品卡")).toEqual(["price", "cta"]);
  });
  it("tags generic material explanation", () => {
    expect(classifySpeechTags("演示商品的材料说明")).toContain("ingredient_or_principle");
  });
  it("ships no private ASR vocabulary", () => { expect(ASR_HOTWORDS).toEqual([]); });
});
