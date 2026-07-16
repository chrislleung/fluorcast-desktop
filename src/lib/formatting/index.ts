import type { ResultApplicabilityDomain } from "../schemas";

const targetLabels: Record<string, string> = {
  absorption_wavelength: "Absorption wavelength",
  emission_wavelength: "Emission wavelength",
  excitation_wavelength: "Excitation wavelength",
  quantum_yield: "Quantum yield",
  lifetime: "Fluorescence lifetime",
};

export function formatTargetName(target: string): string {
  return targetLabels[target] ?? target.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatPredictionValue(value: number, unit: string): string {
  if (unit === "ratio") {
    return value.toFixed(2);
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(1);
  }
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

export function getSpectralRegion(wavelengthNm: number): string {
  if (wavelengthNm < 380) return "Ultraviolet";
  if (wavelengthNm < 450) return "Violet";
  if (wavelengthNm < 495) return "Blue";
  if (wavelengthNm < 570) return "Green";
  if (wavelengthNm < 590) return "Yellow";
  if (wavelengthNm < 620) return "Orange";
  if (wavelengthNm <= 750) return "Red";
  return "Near infrared";
}

export function getBrightnessClass(quantumYield: number): string {
  if (quantumYield >= 0.75) return "Very bright";
  if (quantumYield >= 0.45) return "Bright";
  if (quantumYield >= 0.15) return "Moderate";
  return "Dim";
}

export function getApplicabilityConfidenceLabel(
  applicabilityDomain: ResultApplicabilityDomain,
): string {
  if (applicabilityDomain.outside_applicability_domain) return "Low confidence";
  if (
    applicabilityDomain.exact_solvent_pair_match ||
    applicabilityDomain.exact_molecule_match ||
    applicabilityDomain.nearest_training_similarity >= 0.85
  ) {
    return "High confidence";
  }
  if (
    applicabilityDomain.scaffold_match ||
    applicabilityDomain.nearest_training_similarity >= 0.65
  ) {
    return "Moderate confidence";
  }
  return "Low confidence";
}
