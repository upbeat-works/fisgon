import { type FisgonConfig } from './core/types.js'

export type {
	ProbeEvent,
	Tick,
	Action,
	InteractCommand,
	ScopedProbe,
	Probe,
	FisgonConfig,
	FetchProbeConfig,
	ProbesConfig,
	IdentityConfig,
	TickConfig,
	BrowserMode,
} from './core/types.js'

export function defineConfig(config: FisgonConfig): FisgonConfig {
	return config
}
