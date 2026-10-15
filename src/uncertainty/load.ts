/** Node-only boundary; the sampler and its types remain browser-safe. */
import { readFile } from "node:fs/promises";
import type { UncertaintyModel } from "../model/uncertainty.js";

export async function loadUncertainty(): Promise<UncertaintyModel> {
  const value = JSON.parse(await readFile(new URL("../../data/uncertainty/distributions.json", import.meta.url), "utf8"));
  if (value.version !== 1) throw new Error(`Unsupported uncertainty model version: ${value.version}`);
  return value as UncertaintyModel;
}
