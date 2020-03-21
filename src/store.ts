import { Store } from "mx-puppet-bridge";

const CURRENT_SCHEMA = 1;

export class SlackStore {
	constructor(
		private store: Store,
	) { }

	public async init(): Promise<void> {
		await this.store.init(CURRENT_SCHEMA, "slack_schema", (version: number) => {
			return require(`./db/schema/v${version}.js`).Schema;
		}, false);
	}
}
