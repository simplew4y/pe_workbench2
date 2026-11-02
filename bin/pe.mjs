#!/usr/bin/env node

import { main } from "../cli/index.mjs";

process.exitCode = await main(process.argv.slice(2));
