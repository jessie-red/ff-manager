/** Offline rebuild after download. Requires Poppler's pdftotext on PATH. */
import { writeFile } from "node:fs/promises";
import { prepare, DATA_ROOT } from "./prepare.js";
import { fit, seasonTotalDistributions } from "./fit.js";

const { weekly, preseason, audit } = await prepare();
const { model, report, comparisons } = fit(weekly, preseason);
for (const [path, data] of Object.entries({
  "distributions.json": model, "report.json": { audit, fits: report }, "season-comparisons.json": comparisons,
  "season-total-distributions.json": seasonTotalDistributions(preseason),
})) await writeFile(DATA_ROOT + path, JSON.stringify(data, null, 2) + "\n");
console.log(`Saved ${preseason.length} preseason forecasts and ${weekly.length} player-week records.`);
console.log("Built standard/half/PPR distributions, season comparisons, and held-out weekly diagnostics.");
console.log("See data/uncertainty/report.json for source/exclusion audits and calibration.");
