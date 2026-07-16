import { describe, expect, it } from "vitest";
import {
  formatPredictionValue,
  formatTargetName,
  getApplicabilityConfidenceLabel,
  getBrightnessClass,
  getSpectralRegion,
} from "./index";

describe("formatting helpers", () => {
  it("formats known and unknown target names", () => {
    expect(formatTargetName("emission_wavelength")).toBe("Emission wavelength");
    expect(formatTargetName("custom_target_name")).toBe("Custom Target Name");
  });

  it("formats prediction values by unit and magnitude", () => {
    expect(formatPredictionValue(462.678, "nm")).toBe("462.7");
    expect(formatPredictionValue(0.643, "ratio")).toBe("0.64");
    expect(formatPredictionValue(12, "ns")).toBe("12");
  });

  it("derives spectral regions from wavelength predictions", () => {
    expect(getSpectralRegion(365)).toBe("Ultraviolet");
    expect(getSpectralRegion(462.7)).toBe("Blue");
    expect(getSpectralRegion(680)).toBe("Red");
  });

  it("derives brightness classes from quantum yield", () => {
    expect(getBrightnessClass(0.82)).toBe("Very bright");
    expect(getBrightnessClass(0.64)).toBe("Bright");
    expect(getBrightnessClass(0.2)).toBe("Moderate");
    expect(getBrightnessClass(0.04)).toBe("Dim");
  });

  it("labels applicability confidence from domain summary values", () => {
    expect(
      getApplicabilityConfidenceLabel({
        nearest_training_similarity: 0.91,
        outside_applicability_domain: false,
        exact_molecule_match: false,
        exact_solvent_pair_match: false,
        scaffold_match: true,
      }),
    ).toBe("High confidence");

    expect(
      getApplicabilityConfidenceLabel({
        nearest_training_similarity: 0.7,
        outside_applicability_domain: false,
        exact_molecule_match: false,
        exact_solvent_pair_match: false,
        scaffold_match: false,
      }),
    ).toBe("Moderate confidence");

    expect(
      getApplicabilityConfidenceLabel({
        nearest_training_similarity: 0.95,
        outside_applicability_domain: true,
        exact_molecule_match: true,
        exact_solvent_pair_match: true,
        scaffold_match: true,
      }),
    ).toBe("Low confidence");
  });
});
