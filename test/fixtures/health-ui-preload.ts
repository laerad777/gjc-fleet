import { manualHealthTimer } from "./manual-health-timer";

const timer = manualHealthTimer();
process.on("message", async (message: unknown) => {
	if (message !== "health-test-tick") return;
	try {
		process.send?.(await timer.tick());
	} catch {
		process.send?.({ error: "health_test_tick_failed" });
	}
});
