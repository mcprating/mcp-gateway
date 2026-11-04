#!/usr/bin/env node
/**
 * What a raw launch starts in the gateway-raw-launch and gateway-saved-launch
 * scenarios. It writes a file next to itself and exits, so a run can tell that
 * the command ran. It stands in for anything a command could do.
 */
import { writeFileSync } from "node:fs";

writeFileSync(`${process.argv[1]}.ran`, new Date().toISOString());
