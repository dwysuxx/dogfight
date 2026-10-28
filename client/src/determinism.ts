// Dev aid for the determinism check: open DevTools and run
//   dogfightDeterminism()
// then compare the hash with shared/test/determinism.test.ts (313ef01b).
import { runDeterminismScenario } from "@dogfight/shared/sim/scenario.ts";

declare global {
  interface Window {
    dogfightDeterminism: typeof runDeterminismScenario;
  }
}

window.dogfightDeterminism = runDeterminismScenario;
