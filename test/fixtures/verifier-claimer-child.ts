// Child process for settlement-consistency: the claimer of a verify-test. It runs
// `Fleet.result(taskId, argv)` on the store in argv[2] and dies abruptly (exit 137, no
// finally blocks) as soon as the file in argv[4] exists, i.e. while the admitted test
// command it spawned is still running. It never kills that command.
import { existsSync } from "node:fs";
import { Fleet } from "../../src/fleet";
import { FleetStore } from "../../src/store";

const [db, taskId, marker, argv] = process.argv.slice(2);
const fleet = new Fleet(new FleetStore(db!), { localNodeId: "local" } as any);
setInterval(() => {
	if (existsSync(marker!)) (process as any).reallyExit(137);
}, 5);
await fleet.result(taskId!, JSON.parse(argv!));
console.log("CLAIMER_COMPLETED");
(process as any).reallyExit(0);
