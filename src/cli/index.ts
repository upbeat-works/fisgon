#!/usr/bin/env node

import { Command } from 'commander'
import { actionsCommand } from './commands/actions.js'
import { doCommand } from './commands/do.js'
import { eventsCommand } from './commands/events.js'
import { interactCommand } from './commands/interact.js'
import { navigateCommand } from './commands/navigate.js'
import { openCommand } from './commands/open.js'
import { startCommand } from './commands/start.js'
import { stopCommand } from './commands/stop.js'
import { tickCommand } from './commands/tick.js'

const program = new Command()

program
  .name('fisgon')
  .description('Low-level primitives for LLM-driven application testing')
  .version('0.1.0')

program.addCommand(startCommand)
program.addCommand(stopCommand)
program.addCommand(navigateCommand)
program.addCommand(actionsCommand)
program.addCommand(openCommand)
program.addCommand(interactCommand)
program.addCommand(tickCommand)
program.addCommand(eventsCommand)
program.addCommand(doCommand)

program.parse()
