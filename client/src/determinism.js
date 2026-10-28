// Dev aid for the determinism check: open DevTools and run
//   dogfightDeterminism()
// then compare the hash with `npm test` output (shared/test/determinism.test.js).
import { runDeterminismScenario } from "@dogfight/shared/sim/scenario.js";

window.dogfightDeterminism = (options) => runDeterminismScenario(options);
