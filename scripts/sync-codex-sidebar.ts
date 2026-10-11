import { runSidebarSync } from "../src/sidebar-sync.js";

try {
  await runSidebarSync();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Sidebar sync failed"}\n`
  );
  process.exitCode = 1;
}
